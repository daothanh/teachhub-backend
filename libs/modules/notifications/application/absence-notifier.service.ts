import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import { TxService, type Tx } from '@teachhub/db';
import { PushSender, maskToken, type PushMessage } from '@teachhub/infra';
import {
  isAbsenceRetracted,
  isNewAbsence,
  type AttendanceRecordedPayload,
} from '@teachhub/modules/attendance';
import { formatInZone } from '@teachhub/modules/schedule';

export const TYPE_ABSENT = 'student_absent';
export const TYPE_ABSENT_CORRECTION = 'student_absent_correction';
/** Đính chính chỉ gửi khi cô sửa lại trong chừng này phút kể từ lúc báo vắng (US-3.2). */
export const CORRECTION_WINDOW_MS = 10 * 60_000;
/** Dòng `queued` bỏ dở lâu hơn mức này coi như worker trước đã chết, được nhận lại. */
const STALE_CLAIM_MS = 2 * 60_000;

export interface OutboxJobData {
  eventId: string;
  tenantId: string;
  payload: AttendanceRecordedPayload;
}

interface Pending {
  notificationId: string;
  userId: string;
  type: string;
}

/** Lỗi tạm thời của FCM: ném để BullMQ thử lại cả job (dòng đã `failed` sẽ được nhận lại, không gửi trùng cái đã `sent`). */
export class PushDeliveryError extends Error {}

/**
 * Xử lý sự kiện `attendance_recorded` (S3-BE-06) trong worker: tạo thông báo cho phụ huynh rồi gửi FCM data-only.
 * Idempotent theo `eventId`: khóa `(recipient, dedupe_key)` cho thông báo và `(notification, channel)` cho lần gửi.
 */
@Injectable()
export class AbsenceNotifier {
  private readonly log = new Logger(AbsenceNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly push: PushSender,
  ) {}

  async handle(job: OutboxJobData): Promise<void> {
    const pending = await this.tx.run({ userId: null }, (tx) =>
      this.createNotifications(tx, job),
    );
    let failed = 0;
    for (const p of pending) {
      if (!(await this.deliver(p))) failed++;
    }
    if (failed) throw new PushDeliveryError(`${failed} lần gửi push lỗi tạm`);
  }

  private async createNotifications(
    tx: Tx,
    { eventId, tenantId, payload }: OutboxJobData,
  ): Promise<Pending[]> {
    const interesting = payload.changes.filter(
      (c) =>
        isNewAbsence(c.previousStatus, c.status) ||
        isAbsenceRetracted(c.previousStatus, c.status),
    );
    if (!interesting.length) return [];

    const ctx = (
      await tx.execute<{
        class_id: string;
        class_name: string;
        starts_at: Date;
        tz: string;
      }>(sql`select s.class_id, c.name as class_name, s.starts_at, t.timezone as tz
        from sessions s join classes c on c.tenant_id = s.tenant_id and c.id = s.class_id
        join tenants t on t.id = s.tenant_id
        where s.tenant_id = ${tenantId} and s.id = ${payload.sessionId}`)
    ).rows[0];
    if (!ctx) {
      this.log.warn(
        `buổi ${payload.sessionId} không còn, bỏ qua sự kiện ${eventId}`,
      );
      return [];
    }
    const recordedAt = new Date(payload.recordedAt);
    const out: Pending[] = [];

    for (const c of interesting) {
      const type = isNewAbsence(c.previousStatus, c.status)
        ? TYPE_ABSENT
        : TYPE_ABSENT_CORRECTION;
      const student = (
        await tx.execute<{ full_name: string }>(
          sql`select full_name from students where tenant_id = ${tenantId} and id = ${c.studentId}`,
        )
      ).rows[0];
      if (!student) continue;
      const body = {
        studentId: c.studentId,
        studentName: student.full_name,
        classId: ctx.class_id,
        className: ctx.class_name,
        sessionId: payload.sessionId,
        sessionStartsAt: formatInZone(new Date(ctx.starts_at), ctx.tz),
      };

      // Người nhận: đính chính chỉ tới người đã nhận báo vắng của buổi này trong 10 phút trước đó.
      const recipients =
        type === TYPE_ABSENT
          ? (
              await tx.execute<{
                user_id: string;
                membership_id: string | null;
              }>(sql`
                select distinct g.user_id, m.id as membership_id
                from guardians g
                left join memberships m on m.user_id = g.user_id and m.role = 'parent' and m.status = 'active'
                where g.tenant_id = ${tenantId} and g.student_id = ${c.studentId}
                  and g.deleted_at is null and g.user_id is not null`)
            ).rows
          : (
              await tx.execute<{
                user_id: string;
                membership_id: string | null;
              }>(sql`
                select recipient_user_id as user_id, membership_id from notifications
                where tenant_id = ${tenantId} and type = ${TYPE_ABSENT}
                  and payload->>'sessionId' = ${payload.sessionId}
                  and payload->>'studentId' = ${c.studentId}
                  and created_at >= ${new Date(recordedAt.getTime() - CORRECTION_WINDOW_MS)}`)
            ).rows;

      for (const r of recipients) {
        if (!r.membership_id) {
          this.log.warn(
            `phụ huynh chưa có vai trò parent, bỏ qua (event ${eventId})`,
          );
          continue;
        }
        const row = (
          await tx.execute<{ id: string }>(sql`
            insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, urgency, payload, dedupe_key)
            values (${uuidv7()}, ${tenantId}, ${r.user_id}, ${r.membership_id}, ${type}, 'urgent',
                    ${JSON.stringify(body)}::jsonb, ${`${type}:${eventId}:${c.studentId}`})
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row) out.push({ notificationId: row.id, userId: r.user_id, type });
      }
    }
    return out;
  }

  /** `true` = xong (đã gửi, đã có người khác gửi, hoặc không gửi được vĩnh viễn); `false` = lỗi tạm, cần thử lại. */
  private async deliver(p: Pending): Promise<boolean> {
    const claimed = await this.tx.run({ userId: null }, async (tx) => {
      const ins = await tx.execute(sql`
        insert into notification_deliveries (id, notification_id, channel)
        values (${uuidv7()}, ${p.notificationId}, 'push') on conflict do nothing returning id`);
      if (ins.rows.length) return true;
      const re = await tx.execute(sql`
        update notification_deliveries set status = 'queued', error = null, created_at = now()
        where notification_id = ${p.notificationId} and channel = 'push'
          and (status = 'failed' or (status = 'queued' and created_at < now() - ${STALE_CLAIM_MS} * interval '1 millisecond'))
        returning id`);
      return re.rows.length > 0;
    });
    if (!claimed) return true;

    const devices = await this.tx.run({ userId: null }, async (tx) =>
      (
        await tx.execute<{ token: string }>(
          sql`select token from devices where user_id = ${p.userId}`,
        )
      ).rows.map((r) => r.token),
    );
    const messages: PushMessage[] = devices.map((token) => ({
      token,
      urgent: true,
      data: { notificationId: p.notificationId, type: p.type },
    }));
    const results = this.push.enabled ? await this.push.send(messages) : [];

    const sent = results.find((r) => r.ok);
    const invalid = results.flatMap((r, i) =>
      !r.ok && r.invalidToken ? [devices[i]!] : [],
    );
    let status = 'sent';
    let error: string | null = null;
    let transient = false;
    if (!this.push.enabled) {
      status = 'failed';
      error = 'push_disabled';
    } else if (!devices.length) {
      status = 'failed';
      error = 'no_device';
    } else if (!sent) {
      status = 'failed';
      const errs = results.flatMap((r) => (r.ok ? [] : [r]));
      error = errs[0]?.error ?? 'unknown';
      transient = errs.some((r) => !r.invalidToken);
    }
    if (invalid.length) {
      this.log.debug(
        `xóa ${invalid.length} token hỏng (${invalid.map(maskToken).join(', ')})`,
      );
    }
    await this.tx.run({ userId: null }, async (tx) => {
      await tx.execute(sql`
        update notification_deliveries set status = ${status}, error = ${error},
          provider_message_id = ${sent?.ok ? sent.messageId : null},
          sent_at = ${status === 'sent' ? sql`now()` : null}
        where notification_id = ${p.notificationId} and channel = 'push'`);
      for (const token of invalid) {
        await tx.execute(sql`delete from devices where token = ${token}`);
      }
    });
    return !transient;
  }
}
