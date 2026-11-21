import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Mailer } from '@teachhub/infra';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_PAYMENT_RECORDED = 'payment_recorded';

export const paymentRecordedJobSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.object({
    invoiceId: z.uuid(),
    paymentId: z.uuid(),
    studentId: z.uuid(),
    amount: z.int().min(1),
    paidOn: z.iso.date(),
    status: z.enum(['partially_paid', 'paid']),
    remainingAmount: z.int().min(0),
  }),
});

/** Dòng `queued` bỏ dở lâu hơn mức này coi như worker trước đã chết, được nhận lại (như push ở `AbsenceNotifier`). */
const STALE_CLAIM_MS = 2 * 60_000;

interface Recipient extends Pending {
  email: string | null;
}

// Tiêu đề và nội dung cố định: không tên con, không số tiền (đúng mô tả `paymentRecordedPayloadSchema`).
const MAIL_SUBJECT = 'TeachHub: đã ghi nhận thanh toán học phí';
const MAIL_TEXT =
  'Giáo viên vừa ghi nhận một khoản thanh toán học phí cho con của bạn. Mở ứng dụng TeachHub để xem biên nhận.';

/**
 * Xử lý sự kiện outbox `payment_recorded` (S6-BE-02, US-7.4 AC3): tạo thông báo `payment_recorded` cho phụ huynh đã có tài
 * khoản của học viên, gửi FCM data-only rồi email biên nhận. Idempotent theo `eventId` (khóa `(recipient, dedupe_key)`; lần
 * gửi theo `(notification, channel)`), nhận lại dòng `queued` bỏ dở sau 2 phút. Theo mẫu `InvoiceIssuedNotifier`.
 * shortcut: nhân đôi `deliverEmail` của `InvoiceIssuedNotifier`; gom về một lớp gửi email chung khi có notifier thứ ba.
 * shortcut: phụ huynh chưa kích hoạt tài khoản không nhận email (không có thông báo để làm khóa chống gửi trùng); chưa tôn
 * trọng giờ yên lặng (US-6.5).
 */
@Injectable()
export class PaymentRecordedNotifier {
  private readonly log = new Logger(PaymentRecordedNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
    private readonly mailer: Mailer,
  ) {}

  async handle(job: unknown): Promise<void> {
    const { eventId, tenantId, payload } = paymentRecordedJobSchema.parse(job);
    const pending = await this.tx.run({ userId: null }, async (tx) => {
      const student = (
        await tx.execute<{ full_name: string }>(
          sql`select full_name from students where tenant_id = ${tenantId} and id = ${payload.studentId}`,
        )
      ).rows[0];
      // Thanh toán đã bị hủy trước khi worker xử lý: không báo biên nhận.
      const pay = (
        await tx.execute<{ voided_at: Date | null }>(
          sql`select voided_at from payments where tenant_id = ${tenantId} and id = ${payload.paymentId}`,
        )
      ).rows[0];
      if (!student || !pay || pay.voided_at) return [];
      const guardians = (
        await tx.execute<{
          user_id: string;
          membership_id: string | null;
          email: string | null;
        }>(sql`
          select g.user_id, min(m.id::text)::uuid as membership_id, min(coalesce(g.email, u.email)) as email
          from guardians g
          join users u on u.id = g.user_id
          left join memberships m on m.user_id = g.user_id and m.role = 'parent' and m.status = 'active'
            and (m.student_id is null or m.student_id = g.student_id)
          where g.tenant_id = ${tenantId} and g.student_id = ${payload.studentId}
            and g.deleted_at is null and g.user_id is not null
          group by g.user_id`)
      ).rows;
      const body = {
        invoiceId: payload.invoiceId,
        paymentId: payload.paymentId,
        studentId: payload.studentId,
        studentName: student.full_name,
        amount: payload.amount,
        paidOn: payload.paidOn,
        status: payload.status,
        remainingAmount: payload.remainingAmount,
      };
      const out: Recipient[] = [];
      let skippedNoRole = 0;
      for (const g of guardians) {
        if (!g.membership_id) {
          skippedNoRole++;
          continue;
        }
        const row = (
          await tx.execute<{ id: string }>(sql`
            insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, urgency, payload, dedupe_key, event_at)
            values (${uuidv7()}, ${tenantId}, ${g.user_id}, ${g.membership_id}, ${TYPE_PAYMENT_RECORDED}, 'normal',
                    ${JSON.stringify(body)}::jsonb, ${`${TYPE_PAYMENT_RECORDED}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: g.user_id,
            type: TYPE_PAYMENT_RECORDED,
            urgent: false,
            email: g.email,
          });
      }
      if (skippedNoRole)
        this.log.warn(
          `${skippedNoRole} phụ huynh chưa có vai trò parent, bỏ qua (event ${eventId})`,
        );
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
      if (p.email && !(await this.deliverEmail(p.notificationId, p.email)))
        failed++;
    }
    if (failed) throw new PushDeliveryError(`${failed} lần gửi lỗi tạm`);
  }

  /** `true` = xong (đã gửi, hoặc người khác đang gửi); `false` = lỗi gửi, cần thử lại. */
  private async deliverEmail(
    notificationId: string,
    to: string,
  ): Promise<boolean> {
    const claimed = await this.tx.run({ userId: null }, async (tx) => {
      const ins = await tx.execute(sql`
        insert into notification_deliveries (id, notification_id, channel)
        values (${uuidv7()}, ${notificationId}, 'email') on conflict do nothing returning id`);
      if (ins.rows.length) return true;
      const re = await tx.execute(sql`
        update notification_deliveries set status = 'queued', error = null, created_at = now()
        where notification_id = ${notificationId} and channel = 'email'
          and (status = 'failed' or (status = 'queued' and created_at < now() - ${STALE_CLAIM_MS} * interval '1 millisecond'))
        returning id`);
      return re.rows.length > 0;
    });
    if (!claimed) return true;
    let error: string | null = null;
    try {
      await this.mailer.send({ to, subject: MAIL_SUBJECT, text: MAIL_TEXT });
    } catch (e) {
      error = e instanceof Error ? e.name : 'send_threw';
      this.log.error(`gửi email ${notificationId} lỗi: ${error}`);
    }
    await this.tx.run({ userId: null }, (tx) =>
      tx.execute(sql`
        update notification_deliveries set status = ${error ? 'failed' : 'sent'}, error = ${error},
          sent_at = ${error ? null : sql`now()`}
        where notification_id = ${notificationId} and channel = 'email' and status = 'queued'`),
    );
    return !error;
  }
}
