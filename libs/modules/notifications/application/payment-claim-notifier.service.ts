import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from '@teachhub/core';
import { type Tx, TxService } from '@teachhub/db';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_PAYMENT_CLAIM_CREATED = 'payment_claim_created';
export const TYPE_PAYMENT_CLAIM_REJECTED = 'payment_claim_rejected';

export const paymentClaimJobSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.object({ claimId: z.uuid(), invoiceId: z.uuid() }),
});

interface Target {
  userId: string;
  membershipId: string;
}

/**
 * Xử lý sự kiện outbox `payment_claim_created` (giáo viên) và `payment_claim_rejected` (phụ huynh đã báo) của US-7.7: tạo thông
 * báo rồi gửi FCM (chữ khay chung, không tên, không số tiền). Idempotent theo `eventId` (khóa `(recipient, dedupe_key)`); phần
 * gửi dùng lại `AbsenceNotifier.deliver`. Kiểm lại lúc xử lý: lần báo đã được giáo viên xử lý trước khi worker chạy thì không còn
 * báo "cần xác nhận"; `rejected` chỉ gửi khi lần báo còn `rejected`. Thông báo trong hộp (đã đăng nhập) mang `claimId`, `invoiceId`
 * và, với `rejected`, `reason` của giáo viên (hợp đồng: lý do gửi kèm thông báo cho phụ huynh); push không có lý do.
 * Hai loại này chưa nằm trong `oneOf` của `Notification` (ngoại lệ oasdiff chung, xem contracts/CHANGELOG.md): app đọc trạng thái trực tiếp.
 * shortcut: chưa tôn trọng giờ yên lặng (`send_after` = lúc tạo), như `SubscriptionNotifier`; người nhận `rejected` chỉ là phụ huynh
 * đã báo (không phải mọi người giám hộ của con).
 */
@Injectable()
export class PaymentClaimNotifier {
  private readonly log = new Logger(PaymentClaimNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
  ) {}

  async handleCreated(job: unknown): Promise<void> {
    const { eventId, tenantId, payload } = paymentClaimJobSchema.parse(job);
    await this.notify(
      TYPE_PAYMENT_CLAIM_CREATED,
      eventId,
      tenantId,
      async (tx) => {
        const c = (
          await tx.execute<{ status: string }>(
            sql`select status from payment_claims where tenant_id = ${tenantId} and id = ${payload.claimId}`,
          )
        ).rows[0];
        if (c?.status !== 'pending') return null;
        const owners = (
          await tx.execute<{ user_id: string; membership_id: string }>(sql`
            select m.user_id, m.id as membership_id from memberships m
            where m.tenant_id = ${tenantId} and m.role = 'tenant_owner' and m.status = 'active'`)
        ).rows;
        return {
          targets: owners.map((o) => ({
            userId: o.user_id,
            membershipId: o.membership_id,
          })),
          body: { claimId: payload.claimId, invoiceId: payload.invoiceId },
        };
      },
    );
  }

  async handleRejected(job: unknown): Promise<void> {
    const { eventId, tenantId, payload } = paymentClaimJobSchema.parse(job);
    await this.notify(
      TYPE_PAYMENT_CLAIM_REJECTED,
      eventId,
      tenantId,
      async (tx) => {
        const c = (
          await tx.execute<{
            status: string;
            claimed_by: string;
            reject_reason: string | null;
          }>(
            sql`select status, claimed_by, reject_reason from payment_claims where tenant_id = ${tenantId} and id = ${payload.claimId}`,
          )
        ).rows[0];
        if (c?.status !== 'rejected') return null;
        // Vai trò parent đang hoạt động của người báo, ưu tiên cùng tenant.
        const m = (
          await tx.execute<{ id: string }>(sql`
            select id from memberships where user_id = ${c.claimed_by} and role = 'parent' and status = 'active'
            order by (tenant_id = ${tenantId}) desc, created_at limit 1`)
        ).rows[0];
        if (!m) {
          this.log.warn(
            `người báo chưa có vai trò parent, bỏ qua (event ${eventId})`,
          );
          return null;
        }
        return {
          targets: [{ userId: c.claimed_by, membershipId: m.id }],
          body: {
            claimId: payload.claimId,
            invoiceId: payload.invoiceId,
            reason: c.reject_reason,
          },
        };
      },
    );
  }

  private async notify(
    type: string,
    eventId: string,
    tenantId: string,
    plan: (
      tx: Tx,
    ) => Promise<{ targets: Target[]; body: Record<string, unknown> } | null>,
  ): Promise<void> {
    const pending = await this.tx.run({ userId: null }, async (tx) => {
      const p = await plan(tx);
      const out: Pending[] = [];
      for (const t of p?.targets ?? []) {
        const row = (
          await tx.execute<{ id: string }>(sql`
            insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, urgency, payload, dedupe_key, event_at)
            values (${uuidv7()}, ${tenantId}, ${t.userId}, ${t.membershipId}, ${type}, 'normal',
                    ${JSON.stringify(p!.body)}::jsonb, ${`${type}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: t.userId,
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
