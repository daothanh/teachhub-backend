import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  between,
  eq,
  gt,
  inArray,
  isNotNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import {
  classes,
  scheduleRules,
  sessions,
  tenants,
  type Tx,
} from '@teachhub/db';
import { generateSessions } from '../domain/session-generator.js';
import { formatInZone, localDate } from '../domain/zoned-time.js';
import type {
  PutScheduleRulesRequest,
  ScheduleRulesResult,
  SessionsQuery,
  SessionsResponse,
} from '../http/schedule.schemas.js';
import { toRule } from './schedule-rules.reader.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';
const ruleKey = (r: {
  weekday: number;
  startTime: string;
  durationMin: number;
}) => `${r.weekday}|${r.startTime.slice(0, 5)}|${r.durationMin}`;
const sessionKey = (ruleId: string | null, date: string) => `${ruleId}|${date}`;

/** Lịch lặp và buổi học (US-2.1). Lọc `tenant_id` tường minh, RLS là lớp thứ hai. */
@Injectable()
export class ScheduleService {
  /**
   * Thay bộ quy tắc rồi đối chiếu buổi trong cùng giao dịch. Chỉ đụng buổi tương lai, chưa dạy (`planned`),
   * không phải buổi bù; quy tắc không đổi giữ nguyên `id` nên PUT lại cùng nội dung → 0 buổi sinh/xóa.
   */
  async putRules(
    tx: Tx,
    tenantId: string,
    classId: string,
    body: PutScheduleRulesRequest,
    now = new Date(),
  ): Promise<ScheduleRulesResult> {
    const [cls] = await tx
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, classId)))
      .for('update');
    if (!cls) throw new AppException('NOT_FOUND');
    if (cls.status === 'archived') throw new AppException('CONFLICT_STALE');
    const tz = await this.timezone(tx, tenantId);

    // 1. Quy tắc: giữ nguyên cái trùng hoàn toàn, xóa cái bị thay, thêm cái mới.
    const existing = await tx
      .select()
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.tenantId, tenantId),
          eq(scheduleRules.classId, classId),
        ),
      );
    const byKey = new Map(existing.map((r) => [ruleKey(r), r]));
    const wanted = new Set(body.rules.map(ruleKey));
    const dropped = existing.filter((r) => !wanted.has(ruleKey(r)));
    let removed = 0;
    if (dropped.length) {
      const ids = dropped.map((r) => r.id);
      const gone = await tx
        .delete(sessions)
        .where(
          this.futurePlanned(
            tenantId,
            classId,
            now,
            inArray(sessions.ruleId, ids),
          ),
        )
        .returning({ id: sessions.id });
      removed += gone.length;
      await tx
        .delete(scheduleRules)
        .where(
          and(
            eq(scheduleRules.tenantId, tenantId),
            inArray(scheduleRules.id, ids),
          ),
        );
    }
    const rules = body.rules.map((r) => {
      const kept = byKey.get(ruleKey(r));
      return { id: kept?.id ?? uuidv7(), ...r, isNew: !kept };
    });
    const fresh = rules.filter((r) => r.isNew);
    if (fresh.length) {
      await tx.insert(scheduleRules).values(
        fresh.map((r) => ({
          id: r.id,
          tenantId,
          classId,
          weekday: r.weekday,
          startTime: r.startTime,
          durationMin: r.durationMin,
        })),
      );
    }

    const { generated, removed: gone } = await this.reconcile(
      tx,
      tenantId,
      cls,
      now,
      tz,
    );
    removed += gone;

    const final = await tx
      .select()
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.tenantId, tenantId),
          eq(scheduleRules.classId, classId),
        ),
      )
      .orderBy(asc(scheduleRules.weekday), asc(scheduleRules.startTime));
    return {
      rules: final.map(toRule),
      sessionsGenerated: generated,
      sessionsRemoved: removed,
    };
  }

  /** Buổi trong `[from, to]` (ngày theo múi giờ tenant, gồm hai đầu); lớp đã lưu trữ không hiện. */
  async list(
    tx: Tx,
    tenantId: string,
    query: SessionsQuery,
  ): Promise<SessionsResponse> {
    const tz = await this.timezone(tx, tenantId);
    const rows = await tx
      .select({
        id: sessions.id,
        classId: sessions.classId,
        className: classes.name,
        sessionDate: sessions.sessionDate,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        status: sessions.status,
        isMakeup: sessions.isMakeup,
      })
      .from(sessions)
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(classes.status, 'active'),
          between(sessions.sessionDate, query.from, query.to),
          query.classId ? eq(sessions.classId, query.classId) : undefined,
        ),
      )
      .orderBy(asc(sessions.startsAt), asc(sessions.id));
    return {
      items: rows.map((r) => ({
        ...r,
        status: r.status as 'planned' | 'taught' | 'cancelled',
        startsAt: formatInZone(r.startsAt, tz),
        endsAt: formatInZone(r.endsAt, tz),
      })),
    };
  }

  private futurePlanned(
    tenantId: string,
    classId: string,
    now: Date,
    extra: SQL,
  ) {
    return and(
      eq(sessions.tenantId, tenantId),
      eq(sessions.classId, classId),
      eq(sessions.status, 'planned'),
      eq(sessions.isMakeup, false),
      isNotNull(sessions.ruleId),
      gt(sessions.startsAt, now),
      // Buổi đã có điểm danh (lưu mà chưa chuyển "đã dạy") không bị xóa theo lịch.
      sql`not exists (select 1 from attendance a where a.session_id = ${sessions.id})`,
      extra,
    );
  }

  /**
   * Đối chiếu buổi tương lai của lớp với bộ quy tắc hiện có: xóa buổi `planned` không còn khớp, sinh buổi còn thiếu.
   * Gọi trong giao dịch đã khóa dòng lớp. Idempotent: chạy lại không sinh trùng. Buổi đã có (mọi trạng thái, kể cả
   * `cancelled` hoặc mồ côi `rule_id`) tính theo (lớp, ngày, giờ bắt đầu) nên không bị sinh lại thành buổi dự kiến.
   */
  async reconcile(
    tx: Tx,
    tenantId: string,
    cls: { id: string; startDate: string; endDate: string | null },
    now: Date,
    tz: string,
  ): Promise<{ generated: number; removed: number }> {
    const rules = (
      await tx
        .select()
        .from(scheduleRules)
        .where(
          and(
            eq(scheduleRules.tenantId, tenantId),
            eq(scheduleRules.classId, cls.id),
          ),
        )
    ).map(toRule);
    if (!rules.length) return { generated: 0, removed: 0 };
    const desired = generateSessions(rules, {
      classStart: cls.startDate,
      classEnd: cls.endDate,
      today: localDate(now, tz),
      tz,
    }).filter((s) => s.startsAt > now);
    const wantedKeys = new Set(
      desired.map((s) => sessionKey(s.ruleId, s.sessionDate)),
    );
    const planned = await tx
      .select({
        id: sessions.id,
        ruleId: sessions.ruleId,
        sessionDate: sessions.sessionDate,
      })
      .from(sessions)
      .where(
        this.futurePlanned(
          tenantId,
          cls.id,
          now,
          inArray(
            sessions.ruleId,
            rules.map((r) => r.id),
          ),
        ),
      );
    const stale = planned
      .filter((s) => !wantedKeys.has(sessionKey(s.ruleId, s.sessionDate)))
      .map((s) => s.id);
    if (stale.length) {
      await tx
        .delete(sessions)
        .where(
          and(eq(sessions.tenantId, tenantId), inArray(sessions.id, stale)),
        );
    }
    let generated = 0;
    if (desired.length) {
      const have = await tx
        .select({ date: sessions.sessionDate, startsAt: sessions.startsAt })
        .from(sessions)
        .where(
          and(
            eq(sessions.tenantId, tenantId),
            eq(sessions.classId, cls.id),
            between(
              sessions.sessionDate,
              desired[0]!.sessionDate,
              desired[desired.length - 1]!.sessionDate,
            ),
          ),
        );
      const haveKeys = new Set(
        have.map((s) => `${s.date}|${s.startsAt.getTime()}`),
      );
      const missing = desired.filter(
        (s) => !haveKeys.has(`${s.sessionDate}|${s.startsAt.getTime()}`),
      );
      if (missing.length) {
        const rows = await tx
          .insert(sessions)
          .values(
            missing.map((s) => ({
              id: uuidv7(),
              tenantId,
              classId: cls.id,
              ruleId: s.ruleId,
              sessionDate: s.sessionDate,
              startsAt: s.startsAt,
              endsAt: s.endsAt,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: sessions.id });
        generated = rows.length;
      }
    }
    return { generated, removed: stale.length };
  }

  /** Múi giờ của tenant (mặc định `Asia/Ho_Chi_Minh`). */
  async timezone(tx: Tx, tenantId: string): Promise<string> {
    const [t] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return t?.tz ?? DEFAULT_TZ;
  }
}
