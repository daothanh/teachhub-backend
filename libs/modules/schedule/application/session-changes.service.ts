import { Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import {
  attendance,
  classes,
  recordOutboxEvent,
  sessions,
  type Tx,
} from '@teachhub/db';
import {
  SCHEDULE_CHANGED,
  type ScheduleChangedPayload,
} from '../domain/schedule-events.js';
import { formatInZone, localDate } from '../domain/zoned-time.js';
import type {
  CancelSessionRequest,
  MakeupSessionRequest,
  RescheduleSessionRequest,
  Session,
} from '../http/schedule.schemas.js';
import { ScheduleService } from './schedule.service.js';

type Row = typeof sessions.$inferSelect;

/**
 * Dời, hủy, tạo buổi bù (US-2.2). Mọi lệnh khóa dòng buổi (`FOR UPDATE`) như điểm danh nên hủy và điểm danh
 * không lọt qua nhau; ghi `schedule_changed` vào outbox trong cùng giao dịch.
 */
@Injectable()
export class SessionChangesService {
  constructor(private readonly schedule: ScheduleService) {}

  async reschedule(
    tx: Tx,
    tenantId: string,
    id: string,
    body: RescheduleSessionRequest,
    now = new Date(),
  ): Promise<Session> {
    const { s, className, tz } = await this.load(tx, tenantId, id);
    if (s.status === 'cancelled') throw new AppException('SESSION_CANCELLED');
    if (s.status !== 'planned') throw new AppException('CONFLICT_STALE');
    // Như hủy: buổi đã lưu điểm danh thì không dời giờ, giáo viên phải sửa điểm danh trước.
    if (await this.hasAttendance(tx, tenantId, id)) {
      throw new AppException('SESSION_HAS_ATTENDANCE');
    }
    const startsAt = this.future(body.startsAt, now);
    const length = body.durationMin
      ? body.durationMin * 60_000
      : s.endsAt.getTime() - s.startsAt.getTime();
    const patch = {
      startsAt,
      endsAt: new Date(startsAt.getTime() + length),
      sessionDate: localDate(startsAt, tz),
      // Rời khỏi quy tắc lặp (tránh đụng unique rule+ngày) và nhớ khung giờ gốc cho reconcile.
      ruleId: null,
      rescheduledFrom: s.rescheduledFrom ?? s.startsAt,
    };
    await tx
      .update(sessions)
      .set(patch)
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, id)));
    await this.notify(tx, tenantId, {
      change: 'rescheduled',
      sessionId: id,
      classId: s.classId,
      previousStartsAt: s.startsAt.toISOString(),
      startsAt: startsAt.toISOString(),
      reason: body.reason || null,
      makeupOf: null,
    });
    return this.toSession({ ...s, ...patch }, className, tz);
  }

  async cancel(
    tx: Tx,
    tenantId: string,
    id: string,
    body: CancelSessionRequest,
  ): Promise<Session> {
    const { s, className, tz } = await this.load(tx, tenantId, id, false);
    // Hủy lại buổi đã hủy: trả buổi hiện tại, không ghi đè lý do, không gửi thông báo lần hai.
    if (s.status === 'cancelled') return this.toSession(s, className, tz);
    if (s.status === 'taught' || (await this.hasAttendance(tx, tenantId, id))) {
      throw new AppException('SESSION_HAS_ATTENDANCE');
    }
    const patch = {
      status: 'cancelled',
      cancelReason: body.reason || null,
    };
    await tx
      .update(sessions)
      .set(patch)
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, id)));
    await this.notify(tx, tenantId, {
      change: 'cancelled',
      sessionId: id,
      classId: s.classId,
      previousStartsAt: s.startsAt.toISOString(),
      startsAt: s.startsAt.toISOString(),
      reason: body.reason || null,
      makeupOf: null,
    });
    return this.toSession({ ...s, ...patch }, className, tz);
  }

  async makeup(
    tx: Tx,
    tenantId: string,
    id: string,
    body: MakeupSessionRequest,
    now = new Date(),
  ): Promise<Session> {
    const { s, className, tz } = await this.load(tx, tenantId, id);
    if (s.status !== 'cancelled') throw new AppException('CONFLICT_STALE');
    const [taken] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.makeupOf, id),
          // Buổi bù đã hủy thì cho tạo buổi bù mới.
          ne(sessions.status, 'cancelled'),
        ),
      );
    if (taken) throw new AppException('CONFLICT_STALE');
    const startsAt = this.future(body.startsAt, now);
    const length = body.durationMin
      ? body.durationMin * 60_000
      : s.endsAt.getTime() - s.startsAt.getTime();
    const row: Row = {
      id: uuidv7(),
      tenantId,
      classId: s.classId,
      ruleId: null,
      sessionDate: localDate(startsAt, tz),
      startsAt,
      endsAt: new Date(startsAt.getTime() + length),
      status: 'planned',
      isMakeup: true,
      cancelReason: null,
      makeupOf: id,
      rescheduledFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(sessions).values(row);
    await this.notify(tx, tenantId, {
      change: 'makeup',
      sessionId: row.id,
      classId: s.classId,
      previousStartsAt: null,
      startsAt: startsAt.toISOString(),
      reason: null,
      makeupOf: id,
    });
    return this.toSession(row, className, tz);
  }

  private future(iso: string, now: Date): Date {
    const at = new Date(iso);
    if (at <= now) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        startsAt: ['Giờ bắt đầu phải ở tương lai.'],
      });
    }
    return at;
  }

  private async hasAttendance(tx: Tx, tenantId: string, sessionId: string) {
    const [a] = await tx
      .select({ id: attendance.id })
      .from(attendance)
      .where(
        and(
          eq(attendance.tenantId, tenantId),
          eq(attendance.sessionId, sessionId),
        ),
      )
      .limit(1);
    return Boolean(a);
  }

  /** Buổi của tenant, khóa dòng. `requireActive` = lớp đã lưu trữ thì không đổi lịch (409). */
  private async load(
    tx: Tx,
    tenantId: string,
    id: string,
    requireActive = true,
  ) {
    const [r] = await tx
      .select({ s: sessions, className: classes.name, status: classes.status })
      .from(sessions)
      .innerJoin(
        classes,
        and(
          eq(classes.tenantId, sessions.tenantId),
          eq(classes.id, sessions.classId),
        ),
      )
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, id)))
      .for('update', { of: sessions });
    if (!r) throw new AppException('NOT_FOUND');
    if (requireActive && r.status === 'archived') {
      throw new AppException('CONFLICT_STALE');
    }
    return {
      s: r.s,
      className: r.className,
      tz: await this.schedule.timezone(tx, tenantId),
    };
  }

  private notify(tx: Tx, tenantId: string, payload: ScheduleChangedPayload) {
    return recordOutboxEvent(tx, {
      tenantId,
      type: SCHEDULE_CHANGED,
      payload: { ...payload },
    });
  }

  private toSession(s: Row, className: string, tz: string): Session {
    return {
      id: s.id,
      classId: s.classId,
      className,
      sessionDate: s.sessionDate,
      startsAt: formatInZone(s.startsAt, tz),
      endsAt: formatInZone(s.endsAt, tz),
      status: s.status as Session['status'],
      isMakeup: s.isMakeup,
      cancelReason: s.cancelReason,
      makeupOf: s.makeupOf,
    };
  }
}
