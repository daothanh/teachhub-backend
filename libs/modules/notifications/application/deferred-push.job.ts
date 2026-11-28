import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TxService } from '@teachhub/db';
import { JobRuns, Mailer } from '@teachhub/infra';
import { AbsenceNotifier } from './absence-notifier.service.js';
import { deliverEmail } from './email-delivery.js';
import {
  INVOICE_MAIL_SUBJECT,
  INVOICE_MAIL_TEXT,
  TYPE_INVOICE_ISSUED,
} from './invoice-issued-notifier.service.js';
import {
  REMINDER_MAIL_SUBJECT,
  reminderMailText,
  TYPE_PAYMENT_REMINDER,
} from './payment-reminder-notifier.service.js';
import {
  RECORDED_MAIL_SUBJECT,
  RECORDED_MAIL_TEXT,
  TYPE_PAYMENT_RECORDED,
} from './payment-recorded-notifier.service.js';

export const JOB_NOTIFY_DEFERRED_PUSH = 'notify.deferred-push';
/** Mỗi lần chạy xử lý tối đa chừng này thông báo; phần còn lại để lần sau (5 phút). */
export const DEFERRED_BATCH = 500;
/** Chỉ gửi bù tin hoãn tới hạn trong chừng này giờ: chặn việc thử mãi người không có thiết bị và quét lại bảng cũ. */
const LOOKBACK_HOURS = 6;

type Due = {
  id: string;
  user_id: string;
  type: string;
  payload: Record<string, unknown>;
  email: string | null;
  push_done: boolean;
  email_done: boolean;
};

/**
 * Gửi tin không khẩn bị hoãn do giờ yên lặng (US-6.5; Spec §6.7 `notify.quiet-hours-flush`) khi tới `send_after`.
 * Chọn dòng `send_after <= now()` và `send_after > created_at` (chỉ tin từng bị hoãn) chưa có push `sent`; với loại có email
 * (hóa đơn, biên nhận, nhắc nợ) còn chọn dòng đã push nhưng chưa gửi được email. Gửi lại bằng đúng đường của notifier
 * (`AbsenceNotifier.deliver`, `deliverEmail`), idempotent theo `(notification, channel)`; chạy trùng không gửi trùng.
 * shortcut: một lần chạy tối đa 500 dòng, chỉ xét tin tới hạn trong 6 giờ qua; hơn mức đó (worker chết lâu) thì tin cũ hơn không được gửi bù.
 */
@Injectable()
export class DeferredPushJob {
  readonly log = new Logger(DeferredPushJob.name);

  constructor(
    readonly tx: TxService,
    private readonly runs: JobRuns,
    private readonly delivery: AbsenceNotifier,
    readonly mailer: Mailer,
  ) {}

  run(): Promise<number> {
    return this.runs.track(JOB_NOTIFY_DEFERRED_PUSH, async () => {
      const due = await this.tx.run(
        { userId: null },
        async (tx) =>
          (
            await tx.execute<Due>(sql`
            select * from (
              select n.id, n.recipient_user_id as user_id, n.type, n.payload, n.send_after,
                (select min(coalesce(g.email, u.email)) from users u
                   left join guardians g on g.user_id = u.id and g.tenant_id = n.tenant_id and g.deleted_at is null
                     and g.student_id::text = n.payload->>'studentId'
                   where u.id = n.recipient_user_id) as email,
                exists (select 1 from notification_deliveries d where d.notification_id = n.id and d.channel = 'push' and d.status = 'sent') as push_done,
                exists (select 1 from notification_deliveries d where d.notification_id = n.id and d.channel = 'email' and d.status = 'sent') as email_done
              from notifications n
              where n.send_after > n.created_at and n.send_after <= now()
                and n.send_after > now() - ${LOOKBACK_HOURS} * interval '1 hour'
            ) q
            where not push_done
              or (email is not null and not email_done and type in (${TYPE_INVOICE_ISSUED}, ${TYPE_PAYMENT_REMINDER}, ${TYPE_PAYMENT_RECORDED}))
            order by send_after
            limit ${DEFERRED_BATCH}`)
          ).rows,
      );
      let sent = 0;
      for (const n of due) {
        try {
          if (!n.push_done)
            await this.delivery.deliver({
              notificationId: n.id,
              userId: n.user_id,
              type: n.type,
              urgent: false,
            });
          const mail = n.email && !n.email_done ? mailFor(n) : null;
          if (mail && n.email)
            await deliverEmail(this, n.id, n.email, mail.subject, mail.text);
          sent++;
        } catch (e) {
          // Lỗi một dòng không chặn các dòng khác; dòng chưa xong được chọn lại ở lần chạy sau.
          this.log.error(
            `gửi bù thông báo ${n.id} lỗi: ${e instanceof Error ? e.name : 'lỗi'}`,
          );
        }
      }
      return sent;
    });
  }
}

function mailFor(n: Due): { subject: string; text: string } | null {
  if (n.type === TYPE_INVOICE_ISSUED)
    return { subject: INVOICE_MAIL_SUBJECT, text: INVOICE_MAIL_TEXT };
  if (n.type === TYPE_PAYMENT_RECORDED)
    return { subject: RECORDED_MAIL_SUBJECT, text: RECORDED_MAIL_TEXT };
  if (n.type === TYPE_PAYMENT_REMINDER)
    return {
      subject: REMINDER_MAIL_SUBJECT,
      text: reminderMailText(
        n.payload as Parameters<typeof reminderMailText>[0],
      ),
    };
  return null;
}
