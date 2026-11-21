import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { scheduleRules, type Tx } from '@teachhub/db';
import type { ScheduleRule } from '../http/schedule.schemas.js';

export const toRule = (r: typeof scheduleRules.$inferSelect): ScheduleRule => ({
  id: r.id,
  weekday: r.weekday,
  // `time` của Postgres trả HH:mm:ss
  startTime: r.startTime.slice(0, 5),
  durationMin: r.durationMin,
});

/** Cổng công khai của module schedule cho module khác (classes) đọc quy tắc lặp, không đụng bảng trực tiếp. */
@Injectable()
export class ScheduleRulesReader {
  /** Quy tắc theo lớp, sắp theo thứ rồi giờ bắt đầu. */
  async byClass(
    tx: Tx,
    tenantId: string,
    classIds: string[],
  ): Promise<Map<string, ScheduleRule[]>> {
    const out = new Map<string, ScheduleRule[]>();
    if (!classIds.length) return out;
    const rows = await tx
      .select()
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.tenantId, tenantId),
          inArray(scheduleRules.classId, classIds),
        ),
      )
      .orderBy(asc(scheduleRules.weekday), asc(scheduleRules.startTime));
    for (const r of rows) {
      const list = out.get(r.classId) ?? [];
      list.push(toRule(r));
      out.set(r.classId, list);
    }
    return out;
  }
}
