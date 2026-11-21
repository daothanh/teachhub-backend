import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { recordOutboxEvent, TxService } from '@teachhub/db';
import { JobRuns } from '@teachhub/infra';
import { daysLeft } from '../domain/plan.js';
import {
  reminderOffset,
  SUBSCRIPTION_EXPIRING,
  type SubscriptionExpiringPayload,
} from '../domain/lifecycle.js';

export const JOB_SUBSCRIPTION_LIFECYCLE = 'subscription.lifecycle';

const errorCode = (e: unknown): string => {
  const base = e instanceof Error ? (e.cause ?? e) : e;
  const code = (base as { code?: unknown }).code;
  return typeof code === 'string' ? code : ((base as Error)?.name ?? 'unknown');
};

/**
 * Job `subscription.lifecycle` (US-0.8 AC4, AC5; Spec §6.7, 06:00 hằng ngày giờ VN). Chạy bằng role worker (BYPASSRLS).
 * 1. Chốt hết hạn: `trialing`/`active` quá `current_period_end` → `plan_code = free`, `status = expired` (ghi bền; đọc đã coi là hết hạn
 *    ngay nhờ `effectiveStatus`, job chỉ đồng bộ cột). Một câu UPDATE có điều kiện nên webhook đến cùng lúc (gia hạn) không bị ghi đè:
 *    kỳ mới có `current_period_end` ở tương lai thì không khớp điều kiện.
 * 2. Nhắc gia hạn còn 7 và 1 ngày: mỗi (tenant, hạn, mốc) ghi một dòng `subscription_events` (`source = lifecycle`, khóa duy nhất
 *    `(source, event_id)`) cùng giao dịch với sự kiện outbox `subscription_expiring`; chạy lại thì INSERT không thêm dòng nên không nhắc
 *    trùng. Gia hạn đổi hạn thì có mốc mới, được nhắc lại ở kỳ sau.
 * Mỗi tenant một giao dịch; tenant lỗi được đếm, job ném lỗi cuối lượt để BullMQ thử lại (phần đã làm không lặp lại).
 */
@Injectable()
export class SubscriptionLifecycleJob {
  private readonly log = new Logger(SubscriptionLifecycleJob.name);

  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  /** Trả số tenant đã chốt hết hạn + số lời nhắc đã ghi. */
  run(now = new Date()): Promise<number> {
    return this.runs.track(JOB_SUBSCRIPTION_LIFECYCLE, async () => {
      const expired = await this.tx.run({ userId: null }, async (t) => {
        const r = await t.execute(sql`
          update subscriptions set plan_code = 'free', status = 'expired'
          where status in ('trialing', 'active') and current_period_end is not null and current_period_end <= ${now}`);
        return r.rowCount ?? 0;
      });

      const due = (
        await this.tx.run({ userId: null }, (t) =>
          t.execute<{ tenant_id: string; current_period_end: Date }>(sql`
            select tenant_id, current_period_end from subscriptions
            where status in ('trialing', 'active') and current_period_end > ${now}
              and current_period_end <= ${now}::timestamptz + interval '7 days'`),
        )
      ).rows;

      let reminded = 0;
      let failed = 0;
      for (const s of due) {
        const end = new Date(s.current_period_end);
        const offset = reminderOffset(daysLeft(end, now));
        if (offset === null) continue;
        try {
          const sent = await this.tx.run({ userId: null }, async (t) => {
            const ins = await t.execute(sql`
              insert into subscription_events (id, tenant_id, source, event_id, type, outcome, event_at, payload)
              values (gen_random_uuid(), ${s.tenant_id}, 'lifecycle',
                      ${`reminder:${s.tenant_id}:${end.getTime()}:${offset}`}, 'reminder', 'processed', ${now},
                      ${JSON.stringify({ offsetDays: offset })}::jsonb)
              on conflict (source, event_id) do nothing`);
            if (!ins.rowCount) return 0;
            await recordOutboxEvent(t, {
              tenantId: s.tenant_id,
              type: SUBSCRIPTION_EXPIRING,
              payload: {
                offsetDays: offset,
                currentPeriodEnd: end.toISOString(),
              } satisfies SubscriptionExpiringPayload,
            });
            return 1;
          });
          reminded += sent;
        } catch (e) {
          failed += 1;
          this.log.error(`tenant ${s.tenant_id}: ${errorCode(e)}`);
        }
      }
      if (failed) throw new Error(`${failed} tenant không nhắc được gia hạn`);
      return expired + reminded;
    });
  }
}
