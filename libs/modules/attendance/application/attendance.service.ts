import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import {
  attendance,
  classes,
  enrollments,
  guardians,
  recordOutboxEvent,
  sessions,
  students,
  type Tx,
  users,
} from '@teachhub/db';
import {
  formatInZone,
  localDate,
  ScheduleService,
  zonedToInstant,
} from '@teachhub/modules/schedule';
import {
  addDays,
  ATTENDANCE_RECORDED,
  type AttendanceRecordedPayload,
  type AttendanceStatus,
  adjustedUpdatedAt,
  EDIT_WINDOW_DAYS,
  IMPLICIT_UPDATED_AT,
  isNewAbsence,
  isWithinEditWindow,
  summarize,
  winsLww,
} from '../domain/attendance-policy.js';
import type {
  AttendanceSyncRequest,
  AttendanceSyncResult,
  SessionAttendance,
} from '../http/attendance.schemas.js';

type MutationResult = AttendanceSyncResult['results'][number];
type Current = NonNullable<MutationResult['current']>;

/** Trạng thái một dòng điểm danh trong bộ nhớ trong lúc xử lý lô; ghi xuống CSDL một lần ở cuối. */
interface Line {
  id: string;
  isNew: boolean;
  dirty: boolean;
  /** Từ mutation của client (có trong outbox), khác dòng "Có mặt" tạo ngầm. */
  fromMutation: boolean;
  /** Trạng thái đầu lô; null = chưa có dòng. */
  original: AttendanceStatus | null;
  status: AttendanceStatus;
  note: string | null;
  mutationId: string | null;
  clientUpdatedAt: Date;
  recordedBy: string | null;
}

export interface Actor {
  tenantId: string;
  userId: string;
}

/**
 * Điểm danh (US-3.1, 3.3, 3.5). Mọi truy vấn lọc `tenant_id` tường minh, RLS là lớp thứ hai. Không log ghi chú
 * hay tên học viên.
 */
@Injectable()
export class AttendanceService {
  constructor(private readonly schedule: ScheduleService) {}

  async get(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    now = new Date(),
  ): Promise<SessionAttendance> {
    const s = await this.loadSession(tx, tenantId, sessionId, false);
    const tz = await this.schedule.timezone(tx, tenantId);
    const roster = await this.roster(tx, tenantId, s.classId, s.sessionDate);
    const rows = await tx
      .select()
      .from(attendance)
      .where(
        and(
          eq(attendance.tenantId, tenantId),
          eq(attendance.sessionId, sessionId),
        ),
      );
    const byStudent = new Map(rows.map((r) => [r.studentId, r]));
    const items = roster.map((st) => {
      const r = byStudent.get(st.id);
      return {
        studentId: st.id,
        fullName: st.fullName,
        status: (r?.status as AttendanceStatus | undefined) ?? null,
        note: r?.note ?? null,
        clientUpdatedAt: r ? formatInZone(r.clientUpdatedAt, tz) : null,
        syncedAt: r ? formatInZone(r.syncedAt, tz) : null,
      };
    });
    const windowOpen = isWithinEditWindow(s.sessionDate, localDate(now, tz));
    return {
      sessionId: s.id,
      classId: s.classId,
      className: s.className,
      sessionDate: s.sessionDate,
      startsAt: formatInZone(s.startsAt, tz),
      sessionStatus: s.status as SessionAttendance['sessionStatus'],
      canEdit: windowOpen && s.status !== 'cancelled',
      editableUntil: editableUntil(s.sessionDate, tz),
      serverTime: formatInZone(now, tz),
      items,
      summary: summarize(items.flatMap((i) => (i.status ? [i.status] : []))),
    };
  }

  /**
   * Một lô cho một buổi. Khóa dòng buổi (`FOR UPDATE`) nên hai lô cùng buổi chạy nối tiếp: LWW, dòng "Có mặt" tạo
   * ngầm và chuyển sang đã dạy không đua nhau. Thứ tự kiểm từng phần tử: dedupe → học viên thuộc lớp → cửa sổ 7 ngày
   * → gói chỉ đọc → LWW.
   *
   * shortcut: `client_mutation_id` chỉ lưu mutation thắng gần nhất của dòng; gửi lại mutation cũ hơn mà dòng đã
   * có mutation mới hơn không ra `duplicate` mà ra `stale` (LWW chặn), kết quả vẫn đúng. Hai mutation cùng học viên
   * trong một lô chỉ để lại trạng thái cuối trong nhật ký.
   */
  async sync(
    tx: Tx,
    actor: Actor,
    body: AttendanceSyncRequest,
    now = new Date(),
  ): Promise<AttendanceSyncResult> {
    const { tenantId, userId } = actor;
    const s = await this.loadSession(tx, tenantId, body.sessionId, true);
    if (s.status === 'cancelled') throw new AppException('SESSION_CANCELLED');
    const tz = await this.schedule.timezone(tx, tenantId);
    const windowOpen = isWithinEditWindow(s.sessionDate, localDate(now, tz));
    const deviceTime = new Date(body.deviceTime);

    const roster = await this.roster(tx, tenantId, s.classId, s.sessionDate);
    const rows = await tx
      .select()
      .from(attendance)
      .where(
        and(eq(attendance.tenantId, tenantId), eq(attendance.sessionId, s.id)),
      );
    const dupRows = await tx
      .select({
        sessionId: attendance.sessionId,
        studentId: attendance.studentId,
        mutationId: attendance.clientMutationId,
      })
      .from(attendance)
      .where(
        and(
          eq(attendance.tenantId, tenantId),
          inArray(
            attendance.clientMutationId,
            body.mutations.map((m) => m.clientMutationId),
          ),
        ),
      );
    const enrolled = new Map(roster.map((st) => [st.id, st]));
    const dups = new Map(dupRows.map((d) => [d.mutationId, d]));
    const lines = new Map<string, Line>(
      rows.map((r) => [
        r.studentId,
        {
          id: r.id,
          isNew: false,
          dirty: false,
          fromMutation: false,
          original: r.status as AttendanceStatus,
          status: r.status as AttendanceStatus,
          note: r.note,
          mutationId: r.clientMutationId,
          clientUpdatedAt: r.clientUpdatedAt,
          recordedBy: r.recordedBy,
        },
      ]),
    );

    const results: {
      r: MutationResult;
      current?: Line | undefined;
    }[] = [];
    const rejected = (
      m: AttendanceSyncRequest['mutations'][number],
      errorCode: NonNullable<MutationResult['errorCode']>,
    ) => ({
      r: {
        clientMutationId: m.clientMutationId,
        studentId: m.studentId,
        result: 'rejected' as const,
        errorCode,
      },
    });

    for (const m of body.mutations) {
      const base = {
        clientMutationId: m.clientMutationId,
        studentId: m.studentId,
      };
      const dup = dups.get(m.clientMutationId);
      if (dup) {
        // Chỉ "đã nhận" khi cùng buổi và cùng học viên; trùng id ở buổi khác không lộ gì (giống học viên lạ).
        results.push(
          dup.sessionId === s.id && dup.studentId === m.studentId
            ? {
                r: { ...base, result: 'duplicate' },
                current: lines.get(m.studentId),
              }
            : rejected(m, 'NOT_FOUND'),
        );
        continue;
      }
      const student = enrolled.get(m.studentId);
      if (!student) {
        results.push(rejected(m, 'NOT_FOUND'));
        continue;
      }
      if (!windowOpen) {
        results.push(rejected(m, 'ATTENDANCE_EDIT_WINDOW_CLOSED'));
        continue;
      }
      if (student.isReadonly) {
        results.push(rejected(m, 'READONLY_PLAN_LIMIT'));
        continue;
      }
      const at = adjustedUpdatedAt(
        new Date(m.clientUpdatedAt),
        deviceTime,
        now,
      );
      const line = lines.get(m.studentId);
      if (line && !winsLww(at, line.clientUpdatedAt)) {
        results.push({ r: { ...base, result: 'stale' }, current: line });
        continue;
      }
      lines.set(m.studentId, {
        id: line?.id ?? uuidv7(),
        isNew: line?.isNew ?? !line,
        dirty: true,
        fromMutation: true,
        original: line?.original ?? null,
        status: m.status,
        note: m.note,
        mutationId: m.clientMutationId,
        clientUpdatedAt: at,
        recordedBy: userId,
      });
      results.push({ r: { ...base, result: 'applied' } });
    }

    // Chuyển sang "đã dạy": học viên chưa có dòng mặc định "Có mặt". Buổi đã dạy → bỏ qua cờ (idempotent).
    const taught =
      body.markSessionTaught && windowOpen && s.status === 'planned';
    if (taught) {
      await tx
        .update(sessions)
        .set({ status: 'taught' })
        .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, s.id)));
      for (const st of roster) {
        if (lines.has(st.id)) continue;
        lines.set(st.id, {
          id: uuidv7(),
          isNew: true,
          dirty: true,
          fromMutation: false,
          original: null,
          status: 'present',
          note: null,
          mutationId: null,
          clientUpdatedAt: IMPLICIT_UPDATED_AT,
          recordedBy: userId,
        });
      }
    }

    await this.persist(tx, tenantId, s.id, lines, now);

    const changed = [...lines].filter(([, l]) => l.dirty && l.fromMutation);
    if (changed.length > 0) {
      const payload: AttendanceRecordedPayload = {
        sessionId: s.id,
        recordedAt: now.toISOString(),
        changes: changed.map(([studentId, l]) => ({
          studentId,
          attendanceId: l.id,
          status: l.status,
          previousStatus: l.original,
        })),
      };
      await recordOutboxEvent(tx, {
        tenantId,
        type: ATTENDANCE_RECORDED,
        payload: { ...payload },
      });
    }

    const absent = changed
      .filter(([, l]) => isNewAbsence(l.original, l.status))
      .map(([studentId]) => studentId);
    const parentsToNotify = absent.length
      ? (
          await tx
            .selectDistinct({ userId: guardians.userId })
            .from(guardians)
            .where(
              and(
                eq(guardians.tenantId, tenantId),
                inArray(guardians.studentId, absent),
                isNull(guardians.deletedAt),
              ),
            )
        ).filter((g) => g.userId !== null).length
      : 0;

    const names = await this.recorderNames(
      tx,
      results.flatMap((x) =>
        x.current?.recordedBy ? [x.current.recordedBy] : [],
      ),
    );
    return {
      sessionId: s.id,
      sessionStatus: taught ? 'taught' : (s.status as 'planned' | 'taught'),
      serverTime: formatInZone(now, tz),
      results: results.map(({ r, current }) =>
        current ? { ...r, current: toCurrent(current, tz, names) } : r,
      ),
      summary: summarize([...lines.values()].map((l) => l.status)),
      parentsToNotify,
    };
  }

  /** Ghi các dòng đã đổi: dòng mới một lệnh nhiều dòng, dòng cũ cập nhật theo id. */
  private async persist(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    lines: Map<string, Line>,
    now: Date,
  ): Promise<void> {
    const dirty = [...lines].filter(([, l]) => l.dirty);
    const fresh = dirty.filter(([, l]) => l.isNew);
    if (fresh.length) {
      await tx.insert(attendance).values(
        fresh.map(([studentId, l]) => ({
          id: l.id,
          tenantId,
          sessionId,
          studentId,
          status: l.status,
          note: l.note,
          recordedBy: l.recordedBy,
          clientMutationId: l.mutationId,
          clientUpdatedAt: l.clientUpdatedAt,
          syncedAt: now,
        })),
      );
    }
    for (const [, l] of dirty.filter(([, x]) => !x.isNew)) {
      await tx
        .update(attendance)
        .set({
          status: l.status,
          note: l.note,
          recordedBy: l.recordedBy,
          clientMutationId: l.mutationId,
          clientUpdatedAt: l.clientUpdatedAt,
          syncedAt: now,
        })
        .where(and(eq(attendance.tenantId, tenantId), eq(attendance.id, l.id)));
    }
  }

  /** Buổi của tenant (404 nếu không có). `lock` = `FOR UPDATE` chỉ trên dòng buổi. */
  private async loadSession(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    lock: boolean,
  ) {
    const q = tx
      .select({
        id: sessions.id,
        classId: sessions.classId,
        className: classes.name,
        sessionDate: sessions.sessionDate,
        startsAt: sessions.startsAt,
        status: sessions.status,
      })
      .from(sessions)
      .innerJoin(
        classes,
        and(
          eq(classes.tenantId, sessions.tenantId),
          eq(classes.id, sessions.classId),
        ),
      )
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)));
    const [s] = await (lock ? q.for('update', { of: sessions }) : q);
    if (!s) throw new AppException('NOT_FOUND');
    return s;
  }

  /** Học viên đang học của lớp tại ngày buổi học (ghi danh mở lúc đó), theo tên. */
  private roster(tx: Tx, tenantId: string, classId: string, date: string) {
    return tx
      .select({
        id: students.id,
        fullName: students.fullName,
        isReadonly: students.isReadonly,
      })
      .from(enrollments)
      .innerJoin(
        students,
        and(
          eq(students.tenantId, enrollments.tenantId),
          eq(students.id, enrollments.studentId),
        ),
      )
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.classId, classId),
          lte(enrollments.joinedOn, date),
          or(isNull(enrollments.leftOn), gt(enrollments.leftOn, date)),
        ),
      )
      .orderBy(asc(students.fullName), asc(students.id));
  }

  /** Tên người ghi (RLS của `users` chỉ cho thấy chính user; người khác trả không có tên). */
  private async recorderNames(tx: Tx, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await tx
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(
      rows.flatMap((u) => (u.name ? [[u.id, u.name] as const] : [])),
    );
  }
}

function toCurrent(l: Line, tz: string, names: Map<string, string>): Current {
  const name = l.recordedBy ? names.get(l.recordedBy) : undefined;
  return {
    status: l.status,
    note: l.note,
    clientUpdatedAt: formatInZone(l.clientUpdatedAt, tz),
    ...(name ? { recordedByName: name } : {}),
  };
}

/** Cuối ngày thứ 7 (23:59:59) theo múi giờ tenant. */
function editableUntil(sessionDate: string, tz: string): string {
  const nextDayStart = zonedToInstant(
    addDays(sessionDate, EDIT_WINDOW_DAYS + 1),
    '00:00',
    tz,
  );
  return formatInZone(new Date(nextDayStart.getTime() - 1000), tz);
}
