import { Injectable, Logger } from '@nestjs/common';
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  dunningJobs,
  recordOutboxEvent,
  tenants,
  TxService,
  type Tx,
} from '@teachhub/db';
import { JobRuns } from '@teachhub/infra';
import { formatInZone } from '@teachhub/modules/schedule';
import {
  type DueStep,
  inSendWindow,
  isDunnable,
  parseDunningSettings,
  PAYMENT_REMINDER,
  type PaymentReminderPayload,
  splitDue,
} from '../domain/dunning.js';
import { remainingOf } from '../domain/payment.js';
import { DunningService } from './dunning.service.js';

export const JOB_BILLING_DUNNING = 'billing.dunning';

const errorCode = (e: unknown): string => {
  const base = e instanceof Error ? (e.cause ?? e) : e;
  const code = (base as { code?: unknown }).code;
  return typeof code === 'string' ? code : ((base as Error)?.name ?? 'unknown');
};

/** Phút trong ngày của `at` theo giờ tenant. */
const minuteOfDay = (at: Date, tz: string): number => {
  const t = formatInZone(at, tz);
  return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
};

interface DueRow extends Record<string, unknown> {
  id: string;
  invoice_id: string;
  offset_days: number;
  scheduled_for: Date;
  student_id: string;
  status: string;
  total_amount: string;
  paid_amount: string;
  carried_amount: string;
  due_date: string;
  student_off: boolean;
}

/**
 * Job `billing.dunning` (S6-BE-04, US-7.5): mỗi 15 phút từ 07:00 đến 21:30 giờ VN, gửi các mốc nhắc đã đến giờ. Chạy bằng role
 * worker (BYPASSRLS) nên mọi truy vấn lọc `tenant_id` tường minh; "bây giờ" và khung giờ theo múi giờ từng tenant, ngoài khung
 * thì không gửi (mốc dồn sang khung kế). Mỗi tenant một giao dịch: đánh dấu `sent` và ghi outbox `payment_reminder` cùng commit,
 * nên chạy lại không nhắc trùng (`FOR UPDATE SKIP LOCKED` chặn hai worker song song; dòng đã `sent` không bị chọn lại).
 * shortcut: duyệt mọi tenant mỗi lượt và khung giờ tính theo múi giờ tenant, nhưng cron chạy theo giờ VN (07:00–21:45) nên tenant
 * ở múi giờ khác VN chỉ được gửi trong phần giao của hai khung; MVP chỉ có tenant VN, thêm cron theo múi giờ khi mở nước khác.
 * Race nhỏ: lời nhắc được chốt dựa trên số nợ đọc lúc quét; thu tiền commit ngay sau đó vẫn có thể nhắc nhầm một lần (notifier kiểm lại nợ lúc gửi).
 * Hóa đơn hết đáng nhắc tại lúc gửi (thu đủ, hủy, chuyển nợ, tắt nhắc) thì hủy mốc thay vì gửi.
 */
@Injectable()
export class DunningJob {
  private readonly log = new Logger(DunningJob.name);

  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
    private readonly dunning: DunningService,
  ) {}

  /** Trả số lời nhắc đã gửi. */
  run(now = new Date()): Promise<number> {
    return this.runs.track(JOB_BILLING_DUNNING, async () => {
      const all = await this.tx.run({ userId: null }, (t) =>
        t
          .select({
            id: tenants.id,
            tz: tenants.timezone,
            settings: tenants.settings,
          })
          .from(tenants)
          .where(isNull(tenants.deletedAt)),
      );
      let sent = 0;
      let failed = 0;
      for (const tenant of all) {
        const enabled = parseDunningSettings(tenant.settings).enabled;
        const inWindow = inSendWindow(minuteOfDay(now, tenant.tz));
        try {
          // Lập lịch cho hóa đơn chưa có mốc rồi gửi, cùng một giao dịch; lập lịch không bị khung giờ chặn, gửi thì có.
          sent += await this.tx.run({ userId: null }, async (t) => {
            await this.dunning.scheduleMissing(t, tenant.id);
            return inWindow ? this.sendTenant(t, tenant.id, now, enabled) : 0;
          });
        } catch (e) {
          failed += 1;
          this.log.error(`tenant ${tenant.id}: ${errorCode(e)}`);
        }
      }
      if (failed) throw new Error(`${failed} tenant không gửi được nhắc nợ`);
      return sent;
    });
  }

  private async sendTenant(
    t: Tx,
    tenantId: string,
    now: Date,
    enabled: boolean,
  ): Promise<number> {
    const rows = (
      await t.execute<DueRow>(sql`
        select d.id, d.invoice_id, d.offset_days, d.scheduled_for, i.student_id, i.status,
               i.total_amount::text, i.paid_amount::text, i.carried_amount::text, p.due_date::text,
               exists (select 1 from enrollments e where e.tenant_id = i.tenant_id and e.student_id = i.student_id and e.left_on is null)
                 and not exists (select 1 from enrollments e where e.tenant_id = i.tenant_id and e.student_id = i.student_id
                                   and e.left_on is null and e.dunning_enabled) as student_off
        from dunning_jobs d
        join invoices i on i.tenant_id = d.tenant_id and i.id = d.invoice_id
        join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
        where d.tenant_id = ${tenantId} and d.status = 'pending' and d.scheduled_for <= ${now}
        order by d.invoice_id, d.scheduled_for
        for update of d skip locked`)
    ).rows;
    const byInvoice = new Map<string, DueRow[]>();
    for (const r of rows)
      byInvoice.set(r.invoice_id, [...(byInvoice.get(r.invoice_id) ?? []), r]);

    let sent = 0;
    const cancel = (ids: string[], reason: string) =>
      ids.length
        ? t
            .update(dunningJobs)
            .set({ status: 'cancelled', cancelReason: reason })
            .where(inArray(dunningJobs.id, ids))
        : Promise.resolve();
    for (const group of byInvoice.values()) {
      const f = group[0]!;
      const inv = {
        status: f.status,
        totalAmount: Number(f.total_amount),
        paidAmount: Number(f.paid_amount),
        carriedAmount: Number(f.carried_amount),
      };
      const ids = group.map((g) => g.id);
      const reason =
        f.status === 'void'
          ? 'void'
          : !isDunnable(inv)
            ? 'settled'
            : !enabled
              ? 'tenant_disabled'
              : f.student_off
                ? 'student_disabled'
                : null;
      if (reason) {
        await cancel(ids, reason);
        continue;
      }
      const steps: DueStep[] = group.map((g) => ({
        id: g.id,
        offsetDays: g.offset_days,
        scheduledFor: new Date(g.scheduled_for),
      }));
      const { send, skip } = splitDue(steps);
      await cancel(
        skip.map((s) => s.id),
        'superseded',
      );
      await t
        .update(dunningJobs)
        .set({ status: 'sent', sentAt: now })
        .where(eq(dunningJobs.id, send!.id));
      await recordOutboxEvent(t, {
        tenantId,
        type: PAYMENT_REMINDER,
        payload: {
          invoiceId: f.invoice_id,
          studentId: f.student_id,
          offsetDays: send!.offsetDays,
          remainingAmount: remainingOf(
            inv.totalAmount,
            inv.paidAmount,
            inv.carriedAmount,
          ),
          dueDate: f.due_date,
        } satisfies PaymentReminderPayload,
      });
      sent += 1;
    }
    return sent;
  }
}
