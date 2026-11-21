import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Mailer } from '@teachhub/infra';
import { deliverEmail } from './email-delivery.js';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_INVOICE_ISSUED = 'invoice_issued';

export const invoiceIssuedJobSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.object({
    invoiceId: z.uuid(),
    studentId: z.uuid(),
    periodMonth: z.iso.date(),
    totalAmount: z.int().min(1),
    dueDate: z.iso.date(),
  }),
});

interface Recipient extends Pending {
  email: string | null;
}

// Tiêu đề và nội dung cố định: không tên con, không số tiền (đúng mô tả `invoiceIssuedPayloadSchema`).
const MAIL_SUBJECT = 'TeachHub: có hóa đơn học phí mới';
const MAIL_TEXT =
  'Giáo viên vừa gửi một hóa đơn học phí mới cho con của bạn. Mở ứng dụng TeachHub để xem chi tiết và mã QR chuyển khoản.';

/**
 * Xử lý sự kiện outbox `invoice_issued` (S5-BE-07, US-7.3): tạo thông báo `invoice_issued` cho phụ huynh đã có tài khoản của
 * học viên, gửi FCM data-only rồi email. Idempotent theo `eventId` (khóa `(recipient, dedupe_key)`; lần gửi theo
 * `(notification, channel)`).
 * shortcut: phụ huynh chưa kích hoạt tài khoản (guardians.user_id null) không nhận email, vì không có thông báo để làm khóa
 * chống gửi trùng và họ chưa mở được hóa đơn trong app; mở rộng cùng luồng mời phụ huynh.
 * shortcut: chưa tôn trọng giờ yên lặng (US-6.5).
 */
@Injectable()
export class InvoiceIssuedNotifier {
  readonly log = new Logger(InvoiceIssuedNotifier.name);

  constructor(
    readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
    readonly mailer: Mailer,
  ) {}

  async handle(job: unknown): Promise<void> {
    const { eventId, tenantId, payload } = invoiceIssuedJobSchema.parse(job);
    const pending = await this.tx.run({ userId: null }, async (tx) => {
      const student = (
        await tx.execute<{ full_name: string }>(
          sql`select full_name from students where tenant_id = ${tenantId} and id = ${payload.studentId} and status <> 'left'`,
        )
      ).rows[0];
      // Hóa đơn đã hủy trước khi worker xử lý: không báo.
      const inv = (
        await tx.execute<{ status: string }>(
          sql`select status from invoices where tenant_id = ${tenantId} and id = ${payload.invoiceId}`,
        )
      ).rows[0];
      if (!student || !inv || inv.status === 'void') return [];
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
        periodMonth: payload.periodMonth,
        totalAmount: payload.totalAmount,
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
            values (${uuidv7()}, ${tenantId}, ${g.user_id}, ${g.membership_id}, ${TYPE_INVOICE_ISSUED}, 'normal',
                    ${JSON.stringify(body)}::jsonb, ${`${TYPE_INVOICE_ISSUED}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: g.user_id,
            type: TYPE_INVOICE_ISSUED,
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
      if (
        p.email &&
        !(await deliverEmail(
          this,
          p.notificationId,
          p.email,
          MAIL_SUBJECT,
          MAIL_TEXT,
        ))
      )
        failed++;
    }
    if (failed) throw new PushDeliveryError(`${failed} lần gửi lỗi tạm`);
  }
}
