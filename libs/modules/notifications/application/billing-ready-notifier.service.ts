import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_BILLING_READY = 'billing_ready';

export interface BillingReadyJobData {
  eventId: string;
  tenantId: string;
  payload: {
    periodId: string;
    periodMonth: string;
    draftCount: number;
    draftTotalAmount: number;
  };
}

/**
 * Xử lý sự kiện outbox `billing_drafts_ready` (S5-BE-05, US-7.2 AC1): tạo thông báo `billing_ready` cho chủ tenant rồi gửi
 * FCM data-only (không số tiền, không tên con). Idempotent theo `eventId` (khóa `(recipient, dedupe_key)`); phần gửi dùng
 * lại cơ chế của `AbsenceNotifier.deliver`.
 * shortcut: chưa tôn trọng giờ yên lặng (`send_after` = lúc tạo); thêm khi US-6.5 có cấu hình giờ yên lặng.
 */
@Injectable()
export class BillingReadyNotifier {
  private readonly log = new Logger(BillingReadyNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
  ) {}

  async handle({
    eventId,
    tenantId,
    payload,
  }: BillingReadyJobData): Promise<void> {
    const pending = await this.tx.run({ userId: null }, async (tx) => {
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
            values (${uuidv7()}, ${tenantId}, ${o.user_id}, ${o.membership_id}, ${TYPE_BILLING_READY}, 'normal',
                    ${JSON.stringify(payload)}::jsonb, ${`${TYPE_BILLING_READY}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: o.user_id,
            type: TYPE_BILLING_READY,
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
