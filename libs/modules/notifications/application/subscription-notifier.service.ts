import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from '@teachhub/core';
import { TxService, type Tx } from '@teachhub/db';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_SUBSCRIPTION_EXPIRING = 'subscription_expiring';
export const TYPE_SUBSCRIPTION_ACTIVATED = 'subscription_activated';

const base = { eventId: z.uuid(), tenantId: z.uuid() };

export const subscriptionExpiringJobSchema = z.object({
  ...base,
  payload: z.object({
    offsetDays: z.union([z.literal(7), z.literal(1)]),
    currentPeriodEnd: z.iso.datetime({ offset: true }),
  }),
});
export const subscriptionActivatedJobSchema = z.object({
  ...base,
  payload: z.object({
    source: z.literal('bank_transfer'),
    currentPeriodEnd: z.iso.datetime({ offset: true }),
  }),
});

/**
 * Xử lý sự kiện outbox `subscription_expiring` (nhắc gia hạn còn 7/1 ngày, US-0.8 AC5) và `subscription_activated` (Pro được kích
 * hoạt sau khi quản trị xác nhận chuyển khoản, US-0.8 AC3): tạo thông báo cho chủ tenant rồi gửi FCM (chữ khay chung, không PII,
 * không ngày/số). Idempotent theo `eventId` (khóa `(recipient, dedupe_key)`); phần gửi dùng lại `AbsenceNotifier.deliver`.
 * `subscription_expiring` được kiểm lại lúc xử lý: gói đã gia hạn (hạn khác hạn trong sự kiện) hoặc không còn trả phí thì bỏ.
 * Hai loại này đã nằm trong `oneOf` của `Notification` (ngoại lệ oasdiff một lần, xem contracts/CHANGELOG.md): chưa có deepLink,
 * app đọc trạng thái từ `GET /plan-usage`.
 * shortcut: chưa tôn trọng giờ yên lặng (`send_after` = lúc tạo), như `BillingReadyNotifier`.
 */
@Injectable()
export class SubscriptionNotifier {
  private readonly log = new Logger(SubscriptionNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
  ) {}

  async handleExpiring(job: unknown): Promise<void> {
    const parsed = subscriptionExpiringJobSchema.parse(job);
    const { tenantId, payload } = parsed;
    await this.notifyOwners(TYPE_SUBSCRIPTION_EXPIRING, parsed, async (tx) => {
      const s = (
        await tx.execute<{ status: string; current_period_end: Date | null }>(
          sql`select status, current_period_end from subscriptions where tenant_id = ${tenantId}`,
        )
      ).rows[0];
      return (
        !!s &&
        (s.status === 'trialing' || s.status === 'active') &&
        s.current_period_end !== null &&
        new Date(s.current_period_end).getTime() ===
          new Date(payload.currentPeriodEnd).getTime()
      );
    });
  }

  async handleActivated(job: unknown): Promise<void> {
    await this.notifyOwners(
      TYPE_SUBSCRIPTION_ACTIVATED,
      subscriptionActivatedJobSchema.parse(job),
    );
  }

  private async notifyOwners(
    type: string,
    job: { eventId: string; tenantId: string; payload: object },
    stillValid: (tx: Tx) => Promise<boolean> = () => Promise.resolve(true),
  ): Promise<void> {
    const { eventId, tenantId, payload } = job;
    const pending = await this.tx.run({ userId: null }, async (tx) => {
      if (!(await stillValid(tx))) return [];
      const owners = (
        await tx.execute<{ user_id: string; membership_id: string }>(sql`
          select m.user_id, m.id as membership_id from memberships m
          where m.tenant_id = ${tenantId} and m.role = 'tenant_owner' and m.status = 'active'`)
      ).rows;
      const out: Pending[] = [];
      for (const o of owners) {
        const row = (
          await tx.execute<{ id: string }>(sql`
            insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, urgency, payload, dedupe_key, event_at)
            values (${uuidv7()}, ${tenantId}, ${o.user_id}, ${o.membership_id}, ${type}, 'normal',
                    ${JSON.stringify(payload)}::jsonb, ${`${type}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: o.user_id,
            type,
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
