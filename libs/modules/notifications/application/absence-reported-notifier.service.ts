import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { formatInZone } from '@teachhub/modules/schedule';
import {
  AbsenceNotifier,
  type Pending,
  PushDeliveryError,
} from './absence-notifier.service.js';

export const TYPE_STUDENT_ABSENCE_REPORTED = 'student_absence_reported';

export const absenceReportedJobSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.object({ absenceRequestId: z.uuid() }),
});

/**
 * Xử lý sự kiện outbox `student_absence_reported` (US-3.4 AC1): phụ huynh vừa báo con vắng trước → thông báo + push cho giáo viên
 * (chủ tenant đang hoạt động; lớp chưa có trường giáo viên riêng). Idempotent theo `eventId` (khóa `(recipient, dedupe_key)`); phần
 * gửi dùng lại `AbsenceNotifier.deliver`. Kiểm lại lúc xử lý: báo vắng đã hủy trước khi worker chạy thì không báo. Thông báo
 * trong hộp mang tên con, lớp, buổi, lý do (không có ghi chú tự do); push chỉ có chữ khay chung. Loại này chưa nằm trong `oneOf` của
 * `Notification` (ngoại lệ oasdiff chung, xem contracts/CHANGELOG.md).
 * shortcut: chưa tôn trọng giờ yên lặng (`event_at` = lúc tạo), như `PaymentClaimNotifier`.
 */
@Injectable()
export class AbsenceReportedNotifier {
  private readonly log = new Logger(AbsenceReportedNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly delivery: AbsenceNotifier,
  ) {}

  async handle(job: unknown): Promise<void> {
    const { eventId, tenantId, payload } = absenceReportedJobSchema.parse(job);
    const pending = await this.tx.run({ userId: null }, async (tx) => {
      const a = (
        await tx.execute<{
          student_id: string;
          student_name: string;
          class_id: string;
          class_name: string;
          session_id: string;
          starts_at: Date;
          tz: string;
          reason: string;
        }>(sql`
          select a.student_id, st.full_name as student_name, se.class_id, c.name as class_name, a.session_id,
                 se.starts_at, t.timezone as tz, a.reason
            from absence_requests a
            join students st on st.tenant_id = a.tenant_id and st.id = a.student_id
            join sessions se on se.tenant_id = a.tenant_id and se.id = a.session_id
            join classes c on c.tenant_id = se.tenant_id and c.id = se.class_id
            join tenants t on t.id = a.tenant_id
           where a.tenant_id = ${tenantId} and a.id = ${payload.absenceRequestId} and a.cancelled_at is null`)
      ).rows[0];
      if (!a) return [];
      const owners = (
        await tx.execute<{ user_id: string; membership_id: string }>(sql`
          select m.user_id, m.id as membership_id from memberships m
          where m.tenant_id = ${tenantId} and m.role = 'tenant_owner' and m.status = 'active'`)
      ).rows;
      const body = {
        absenceRequestId: payload.absenceRequestId,
        studentId: a.student_id,
        studentName: a.student_name,
        classId: a.class_id,
        className: a.class_name,
        sessionId: a.session_id,
        sessionStartsAt: formatInZone(new Date(a.starts_at), a.tz),
        reason: a.reason,
      };
      const out: Pending[] = [];
      for (const o of owners) {
        const row = (
          await tx.execute<{ id: string }>(sql`
            insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, urgency, payload, dedupe_key, event_at)
            values (${uuidv7()}, ${tenantId}, ${o.user_id}, ${o.membership_id}, ${TYPE_STUDENT_ABSENCE_REPORTED}, 'normal',
                    ${JSON.stringify(body)}::jsonb, ${`${TYPE_STUDENT_ABSENCE_REPORTED}:${eventId}`}, now())
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row)
          out.push({
            notificationId: row.id,
            userId: o.user_id,
            type: TYPE_STUDENT_ABSENCE_REPORTED,
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
