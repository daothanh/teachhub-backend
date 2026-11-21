import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Mailer } from '@teachhub/infra';
import { reminderCopy } from '@teachhub/modules/billing';
import { deliverEmail } from './email-delivery.js';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_PAYMENT_REMINDER = 'payment_reminder';

export const paymentReminderJobSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.object({
    invoiceId: z.uuid(),
    studentId: z.uuid(),
    offsetDays: z.int(),
    remainingAmount: z.int().min(1),
    dueDate: z.iso.date(),
  }),
});

interface Recipient extends Pending {
  email: string | null;
}

// Tiêu đề cố định (không tên con, không số tiền); thân email có số còn nợ và hạn (US-7.5 AC4), không có tên con.
const MAIL_SUBJECT = 'DayHoc nhắc học phí';

/**
 * Xử lý sự kiện outbox `payment_reminder` (S6-BE-04, US-7.5): tạo thông báo `payment_reminder` cho phụ huynh đã có tài khoản
 * của học viên, gửi FCM (chữ khay chung, không PII, không số tiền) rồi email nhắc ("DayHoc nhắc…" kèm số còn nợ và hạn). Idempotent theo `eventId` (khóa `(recipient, dedupe_key)`; lần
 * gửi theo `(notification, channel)`), nhận lại dòng `queued` bỏ dở sau 2 phút. Theo mẫu `InvoiceIssuedNotifier`.
 * shortcut: phụ huynh chưa kích hoạt tài khoản không nhận email (không có thông báo để làm khóa chống gửi trùng); chưa tôn
 * trọng giờ yên lặng (US-6.5).
 */
@Injectable()
export class PaymentReminderNotifier {
  readonly log = new Logger(PaymentReminderNotifier.name);

  constructor(
    readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
    readonly mailer: Mailer,
  ) {}

  async handle(job: unknown): Promise<void> {
    const { eventId, tenantId, payload } = paymentReminderJobSchema.parse(job);
    const pending = await this.tx.run({ userId: null }, async (tx) => {
      const student = (
        await tx.execute<{ full_name: string }>(
          sql`select full_name from students where tenant_id = ${tenantId} and id = ${payload.studentId} and status <> 'left'`,
        )
      ).rows[0];
      if (!student) return [];
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
        studentId: payload.studentId,
        studentName: student.full_name,
        offsetDays: payload.offsetDays,
        remainingAmount: payload.remainingAmount,
        dueDate: payload.dueDate,
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
            values (${uuidv7()}, ${tenantId}, ${g.user_id}, ${g.membership_id}, ${TYPE_PAYMENT_REMINDER}, 'normal',
                    ${JSON.stringify(body)}::jsonb, ${`${TYPE_PAYMENT_REMINDER}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: g.user_id,
            type: TYPE_PAYMENT_REMINDER,
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

    const mailText = reminderCopy(payload).body;
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
      if (
        p.email &&
        !(await deliverEmail(
          this,
          p.notificationId,
          p.email,
          MAIL_SUBJECT,
          mailText,
        ))
      )
        failed++;
    }
    if (failed) throw new PushDeliveryError(`${failed} lần gửi lỗi tạm`);
  }
}
