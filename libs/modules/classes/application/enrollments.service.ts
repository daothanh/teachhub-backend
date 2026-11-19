import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import { classes, enrollments, students, tenants, type Tx } from '@teachhub/db';
import { localDate } from '@teachhub/modules/schedule';
import type {
  CreateEnrollmentRequest,
  Enrollment,
  Roster,
} from '../http/classes.schemas.js';

const toEnrollment = (r: typeof enrollments.$inferSelect): Enrollment => ({
  id: r.id,
  classId: r.classId,
  studentId: r.studentId,
  joinedOn: r.joinedOn,
});

/** Ghi danh lớp ↔ học viên và danh sách lớp (US-1.4 AC3). Lọc `tenant_id` tường minh, RLS là lớp thứ hai. */
@Injectable()
export class EnrollmentsService {
  /** 201 khi tạo mới, 200 khi học viên đã ghi danh mở ở lớp này (trả bản cũ). */
  async enroll(
    tx: Tx,
    tenantId: string,
    classId: string,
    body: CreateEnrollmentRequest,
  ): Promise<{ status: 200 | 201; body: Enrollment }> {
    const [cls] = await tx
      .select({ status: classes.status })
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, classId)))
      // Khóa chia sẻ: lớp bị lưu trữ / học viên bị đánh dấu nghỉ song song phải chờ ghi danh này xong.
      .for('share');
    // studentId của tenant khác trả cùng mã với studentId không tồn tại.
    const [student] = await tx
      .select({ status: students.status })
      .from(students)
      .where(
        and(eq(students.tenantId, tenantId), eq(students.id, body.studentId)),
      )
      .for('share');
    if (!cls || !student) throw new AppException('NOT_FOUND');
    if (cls.status === 'archived' || student.status === 'left') {
      throw new AppException('CONFLICT_STALE');
    }

    const open = and(
      eq(enrollments.tenantId, tenantId),
      eq(enrollments.classId, classId),
      eq(enrollments.studentId, body.studentId),
      isNull(enrollments.leftOn),
    );
    const [existing] = await tx.select().from(enrollments).where(open);
    if (existing) return { status: 200, body: toEnrollment(existing) };

    // shortcut: không chặn vượt sĩ số tối đa (`classes.capacity`): PRD/Spec không yêu cầu chặn cứng; thêm khi có
    // yêu cầu (khóa FOR UPDATE dòng lớp rồi đếm ghi danh mở trước khi insert).
    // shortcut: chưa kiểm hạn mức gói khi ghi danh (max_active_students, US-0.7); PlanLimitService vào cùng US-0.7
    // → kiểm ở đây trước khi insert và ném PLAN_LIMIT_EXCEEDED.
    const [row] = await tx
      .insert(enrollments)
      .values({
        id: uuidv7(),
        tenantId,
        classId,
        studentId: body.studentId,
        joinedOn: body.joinedOn ?? (await this.today(tx, tenantId)),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { status: 201, body: toEnrollment(row) };
    // Request song song vừa ghi danh xong (unique ghi danh mở): trả bản đó.
    const [raced] = await tx.select().from(enrollments).where(open);
    return { status: 200, body: toEnrollment(raced!) };
  }

  /** Chỉ ghi danh chưa rời lớp, học viên `active`/`paused`. */
  async roster(tx: Tx, tenantId: string, classId: string): Promise<Roster> {
    const [cls] = await tx
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, classId)));
    if (!cls) throw new AppException('NOT_FOUND');
    const rows = await tx
      .select({
        enrollmentId: enrollments.id,
        studentId: students.id,
        fullName: students.fullName,
        studentStatus: students.status,
        joinedOn: enrollments.joinedOn,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.classId, classId),
          isNull(enrollments.leftOn),
          ne(students.status, 'left'),
        ),
      )
      .orderBy(asc(students.fullNameUnaccent), asc(students.id));
    return {
      items: rows.map((r) => ({
        ...r,
        studentStatus: r.studentStatus as 'active' | 'paused',
      })),
    };
  }

  /** Ngày hôm nay theo múi giờ của tenant (`YYYY-MM-DD`). */
  private async today(tx: Tx, tenantId: string): Promise<string> {
    const [t] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return localDate(new Date(), t?.tz ?? 'Asia/Ho_Chi_Minh');
  }
}
