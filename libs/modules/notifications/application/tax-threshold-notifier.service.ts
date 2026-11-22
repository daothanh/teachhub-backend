import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_TAX_THRESHOLD_ALERT = 'tax_threshold_alert';

export const taxThresholdAlertJobSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.object({
    alertId: z.uuid(),
    fiscalYear: z.int(),
    milestone: z.enum(['400m', '800m']),
  }),
});

/**
 * Xử lý sự kiện outbox `tax_threshold_alert` (US-9.5 AC3): tạo thông báo cho chủ tenant rồi gửi FCM (chữ khay chung, không số
 * tiền, không PII). Cảnh báo bị đóng trước khi xử lý thì bỏ. Idempotent theo `eventId` như `SubscriptionNotifier`.
 * Loại này CHƯA nằm trong `oneOf` của `Notification` (contracts/CHANGELOG.md, Sprint 8: chờ PR riêng trước khi nộp store); payload
 * chỉ { fiscalYear, milestone }. Tới đó app đọc `alerts` của `GET /compliance/revenue-book`.
 * shortcut: chưa tôn trọng giờ yên lặng ở handler (job nguồn chạy 08:00; sinh lúc đọc sổ là lúc người dùng đang mở app).
 */
@Injectable()
export class TaxThresholdNotifier {
  private readonly log = new Logger(TaxThresholdNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
  ) {}

  async handle(job: unknown): Promise<void> {
    const { eventId, tenantId, payload } =
      taxThresholdAlertJobSchema.parse(job);
    const pending = await this.tx.run({ userId: null }, async (tx) => {
      const open = (
        await tx.execute(sql`
          select 1 from tax_threshold_alerts
           where tenant_id = ${tenantId}::uuid and id = ${payload.alertId}::uuid and dismissed_at is null`)
      ).rows.length;
      if (!open) return [];
      const owners = (
        await tx.execute<{ user_id: string; membership_id: string }>(sql`
          select m.user_id, m.id as membership_id from memberships m
          where m.tenant_id = ${tenantId} and m.role = 'tenant_owner' and m.status = 'active'`)
      ).rows;
      const body = {
        fiscalYear: payload.fiscalYear,
        milestone: payload.milestone,
      };
      const out: Pending[] = [];
      for (const o of owners) {
        const row = (
          await tx.execute<{ id: string }>(sql`
            insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, urgency, payload, dedupe_key, event_at)
            values (${uuidv7()}, ${tenantId}, ${o.user_id}, ${o.membership_id}, ${TYPE_TAX_THRESHOLD_ALERT}, 'normal',
                    ${JSON.stringify(body)}::jsonb, ${`${TYPE_TAX_THRESHOLD_ALERT}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: o.user_id,
            type: TYPE_TAX_THRESHOLD_ALERT,
            urgent: false,
          });
      }
      return out;
    });
    let failed = 0;
    for (const p of pending) {
      try {
        if (!(await this.delivery.deliver(p))) failed++;
      } catch (e) {
        failed++;
        this.log.error(
          `gửi thông báo ${p.notificationId} lỗi: ${e instanceof Error ? e.name : 'lỗi'}`,
        );
      }
    }
    if (failed) throw new PushDeliveryError(`${failed} lần gửi push lỗi tạm`);
  }
}
