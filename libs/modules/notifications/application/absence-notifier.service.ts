import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import { TxService, type Tx } from '@teachhub/db';
import { PushSender, maskToken, pushCopyFor } from '@teachhub/infra';
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

export interface Pending {
  notificationId: string;
  userId: string;
  type: string;
  /** Mặc định khẩn (báo vắng); tin thường (vd. học phí sẵn sàng) đặt `false`. */
  urgent?: boolean;
}

/** Lỗi tạm thời của FCM: ném để BullMQ thử lại cả job (dòng đã `failed` sẽ được nhận lại, không gửi trùng cái đã `sent`). */
export class PushDeliveryError extends Error {}

/**
 * shortcut: đọc chéo module (attendance, guardians, memberships, sessions) bằng SQL thô trong worker để khỏi kéo cả service của module khác; đổi sang port/reader khi có consumer thứ hai.
 * shortcut: nhiều thiết bị của một người nhận tính `sent` khi MỘT thiết bị nhận được; thiết bị còn lại lỗi tạm không được thử lại riêng.
 *
 * Xử lý sự kiện `attendance_recorded` (S3-BE-06) trong worker: tạo thông báo cho phụ huynh rồi gửi FCM (khay chữ chung + `data` định danh).
 * Idempotent theo `eventId`: khóa `(recipient, dedupe_key)` cho thông báo và `(notification, channel)` cho lần gửi.
 */
@Injectable()
export class AbsenceNotifier {
  private readonly log = new Logger(AbsenceNotifier.name);

  constructor(
    private readonly tx: TxService,
    private readonly push: PushSender,
  ) {}

  /**
   * Gửi theo từng người nhận, lỗi của người này không chặn người khác; gom lại và ném MỘT lần để BullMQ thử lại cả job
   * (người đã `sent` bị bỏ qua nhờ khóa delivery).
   * shortcut: at-least-once. Worker chết giữa lúc FCM đã nhận và lúc ghi `sent` thì sau 2 phút dòng `queued` được nhận
   * lại và có thể gửi trùng một tin; đủ cho báo vắng, đổi sang exactly-once cần khóa phía FCM.
   */
  async handle(job: OutboxJobData): Promise<void> {
    const pending = await this.tx.run({ userId: null }, (tx) =>
      this.createNotifications(tx, job),
    );
    let failed = 0;
    for (const p of pending) {
      try {
        if (!(await this.deliver(p))) failed++;
      } catch (e) {
        failed++;
        this.log.error(
          `gửi thông báo ${p.notificationId} lỗi: ${e instanceof Error ? e.name : 'lỗi'}`,
        );
      }
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
      if (type === TYPE_ABSENT) {
        // Sự kiện có thể tới sau bản đính chính (retry, đảo thứ tự): chỉ báo khi dòng điểm danh còn vắng không phép.
        const cur = (
          await tx.execute<{ status: string }>(
            sql`select status from attendance where tenant_id = ${tenantId} and id = ${c.attendanceId}`,
          )
        ).rows[0];
        if (cur?.status !== 'unexcused') continue;
      }
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

      // Người nhận: đính chính chỉ tới người ĐÃ NHẬN (delivery 'sent') báo vắng của buổi này trong 10 phút trước đó;
      // báo vắng chưa tới ai thì không có gì để đính chính.
      // shortcut: dòng trước migration 0022 có event_at NULL thì lấy created_at làm dự phòng; bỏ coalesce khi không còn dòng cũ.
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
                  and (m.student_id is null or m.student_id = g.student_id)
                where g.tenant_id = ${tenantId} and g.student_id = ${c.studentId}
                  and g.deleted_at is null and g.user_id is not null`)
            ).rows
          : (
              await tx.execute<{
                user_id: string;
                membership_id: string | null;
              }>(sql`
                select n.recipient_user_id as user_id, n.membership_id from notifications n
                join notification_deliveries d on d.notification_id = n.id and d.channel = 'push' and d.status = 'sent'
                where n.tenant_id = ${tenantId} and n.type = ${TYPE_ABSENT}
                  and n.payload->>'sessionId' = ${payload.sessionId}
                  and n.payload->>'studentId' = ${c.studentId}
                  and coalesce(n.event_at, n.created_at) >= ${new Date(recordedAt.getTime() - CORRECTION_WINDOW_MS)}`)
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
            insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, urgency, payload, dedupe_key, event_at)
            values (${uuidv7()}, ${tenantId}, ${r.user_id}, ${r.membership_id}, ${type}, 'urgent',
                    ${JSON.stringify(body)}::jsonb, ${`${type}:${eventId}:${c.studentId}`}, ${recordedAt})
            on conflict (recipient_user_id, dedupe_key) do update set dedupe_key = excluded.dedupe_key
            returning id`)
        ).rows[0];
        if (row) out.push({ notificationId: row.id, userId: r.user_id, type });
      }
    }
    return out;
  }

  /** `true` = xong (đã gửi hoặc không gửi được vĩnh viễn); `false` = lỗi tạm hoặc đang có người khác gửi, cần thử lại. */
  async deliver(p: Pending): Promise<boolean> {
    const claim = await this.tx.run({ userId: null }, async (tx) => {
      const ins = await tx.execute(sql`
        insert into notification_deliveries (id, notification_id, channel)
        values (${uuidv7()}, ${p.notificationId}, 'push') on conflict do nothing returning id`);
      if (ins.rows.length) return 'claimed';
      const re = await tx.execute(sql`
        update notification_deliveries set status = 'queued', error = null, created_at = now()
        where notification_id = ${p.notificationId} and channel = 'push'
          and (status = 'failed' or (status = 'queued' and created_at < now() - ${STALE_CLAIM_MS} * interval '1 millisecond'))
        returning id`);
      if (re.rows.length) return 'claimed';
      const cur = (
        await tx.execute<{ status: string }>(
          sql`select status from notification_deliveries where notification_id = ${p.notificationId} and channel = 'push'`,
        )
      ).rows[0];
      return cur?.status === 'sent' ? 'done' : 'busy';
    });
    if (claim === 'done') return true;
    // 'busy': lần trước còn dở (dòng queued chưa quá hạn); ném để BullMQ thử lại thay vì coi như xong.
    if (claim === 'busy') return false;

    let status = 'sent';
    let error: string | null = null;
    let transient = false;
    let messageId: string | null = null;
    let invalid: string[] = [];
    try {
      const devices = await this.tx.run({ userId: null }, async (tx) =>
        (
          await tx.execute<{ token: string }>(
            sql`select token from devices where user_id = ${p.userId}`,
          )
        ).rows.map((r) => r.token),
      );
      const copy = pushCopyFor(p.type);
      const results = this.push.enabled
        ? await this.push.send(
            devices.map((token) => ({
              token,
              copy,
              urgent: p.urgent ?? true,
              data: { notificationId: p.notificationId, type: p.type },
            })),
          )
        : [];
      const sent = results.find((r) => r.ok);
      messageId = sent?.ok ? sent.messageId : null;
      invalid = results.flatMap((r, i) => {
        const token = devices[i];
        return !r.ok && r.invalidToken && token ? [token] : [];
      });
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
    } catch (e) {
      // Lỗi hạ tầng khi gửi: trả dòng về `failed` để lần thử lại nhận được ngay, rồi báo lỗi tạm.
      status = 'failed';
      error = e instanceof Error ? e.name : 'send_threw';
      transient = true;
    }
    if (invalid.length) {
      this.log.debug(
        `xóa ${invalid.length} token hỏng (${invalid.map(maskToken).join(', ')})`,
      );
    }
    await this.tx.run({ userId: null }, async (tx) => {
      await tx.execute(sql`
        update notification_deliveries set status = ${status}, error = ${error},
          provider_message_id = ${messageId},
          sent_at = ${status === 'sent' ? sql`now()` : null}
        where notification_id = ${p.notificationId} and channel = 'push' and status = 'queued'`);
      for (const token of invalid) {
        await tx.execute(
          sql`delete from devices where token = ${token} and user_id = ${p.userId}`,
        );
      }
    });
    return !transient;
  }
}
