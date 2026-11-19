import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '@teachhub/core';
import { type Tx, TxService } from '@teachhub/db';
import { ConsentsService } from '@teachhub/modules/identity';
import { localDate } from '@teachhub/modules/schedule';
import { summarizeWeek, weekRange } from '../domain/week.js';
import type {
  FamilyAttendanceWeek,
  FamilyStudentList,
} from '../http/family.schemas.js';

/**
 * Phụ huynh đọc con của mình (S4-BE-06). Mọi truy vấn đi qua hàm CSDL lọc theo `linked_student_ids()` (user từ
 * `app.user_id`), KHÔNG theo `ctx.tenantId`: phụ huynh có con ở nhiều giáo viên. Mỗi hàm chỉ trả cột trong allowlist
 * (không ghi chú giáo viên, ngày sinh, liên hệ). Đọc qua hàm security definer thay vì mở policy `select` trên bảng
 * để phụ huynh không bao giờ chạm tới cột ngoài allowlist, kể cả khi code API sai.
 */
@Injectable()
export class FamilyService {
  constructor(
    private readonly tx: TxService,
    private readonly consents: ConsentsService,
  ) {}

  async students(userId: string): Promise<FamilyStudentList> {
    await this.consents.assertAccepted(userId, 'parent');
    const rows = await this.tx.run(
      { userId },
      async (t) =>
        (
          await t.execute<{
            student_id: string;
            full_name: string;
            class_id: string | null;
            class_name: string | null;
            teacher_name: string;
          }>(sql`select * from app_private.family_students()`)
        ).rows,
    );
    const byStudent = new Map<string, FamilyStudentList['items'][number]>();
    for (const r of rows) {
      const item = byStudent.get(r.student_id) ?? {
        id: r.student_id,
        fullName: r.full_name,
        classes: [],
      };
      if (r.class_id && r.class_name) {
        item.classes.push({
          id: r.class_id,
          name: r.class_name,
          teacherName: r.teacher_name,
        });
      }
      byStudent.set(r.student_id, item);
    }
    return { items: [...byStudent.values()] };
  }

  async attendance(
    userId: string,
    studentId: string,
    week: string | undefined,
    now = new Date(),
  ): Promise<FamilyAttendanceWeek> {
    await this.consents.assertAccepted(userId, 'parent');
    return this.tx.run({ userId }, async (t) => {
      const tz = await this.timezone(t, studentId);
      // Không liên kết (học viên khác, tenant khác, đã gỡ, không tồn tại) → cùng 404.
      if (!tz) throw new AppException('NOT_FOUND');
      const { start, end } = weekRange(week ?? localDate(now, tz));
      const rows = (
        await t.execute<{
          session_id: string;
          class_id: string;
          class_name: string;
          starts_at: Date | string;
          ends_at: Date | string;
          session_status: 'planned' | 'taught' | 'cancelled';
          is_makeup: boolean;
          attendance_status:
            'present' | 'late' | 'excused' | 'unexcused' | null;
        }>(
          sql`select * from app_private.family_week_sessions(${studentId}::uuid, ${start}::date, ${end}::date)`,
        )
      ).rows;
      const sessions = rows.map((r) => ({
        sessionId: r.session_id,
        classId: r.class_id,
        className: r.class_name,
        startsAt: new Date(r.starts_at),
        endsAt: new Date(r.ends_at),
        sessionStatus: r.session_status,
        isMakeup: r.is_makeup,
        attendanceStatus: r.attendance_status,
      }));
      return {
        studentId,
        weekStart: start,
        weekEnd: end,
        summary: summarizeWeek(sessions, now),
        sessions: sessions.map((s) => ({
          ...s,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
        })),
      };
    });
  }

  private async timezone(t: Tx, studentId: string): Promise<string | null> {
    const r = await t.execute<{ timezone: string }>(
      sql`select * from app_private.family_student_timezone(${studentId}::uuid)`,
    );
    return r.rows[0]?.timezone ?? null;
  }
}
