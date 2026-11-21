import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import {
  classes,
  enrollments,
  guardians,
  students,
  tenants,
  type Tx,
} from '@teachhub/db';
import { localDate } from '@teachhub/modules/schedule';
import type {
  CreateEnrollmentRequest,
  Enrollment,
  FeeOverride,
  FeeOverrideResult,
  PutFeeOverrideRequest,
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
        feeOverride: enrollments.feeOverride,
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
    const gs = rows.length
      ? await tx
          .select({
            id: guardians.id,
            studentId: guardians.studentId,
            fullName: guardians.fullName,
            relation: guardians.relation,
          })
          .from(guardians)
          .where(
            and(
              eq(guardians.tenantId, tenantId),
              inArray(
                guardians.studentId,
                rows.map((r) => r.studentId),
              ),
              isNull(guardians.deletedAt),
            ),
          )
          .orderBy(asc(guardians.createdAt), asc(guardians.id))
      : [];
    return {
      items: rows.map((r) => ({
        ...r,
        studentStatus: r.studentStatus as 'active' | 'paused',
        // shortcut: chưa có bảng lời mời phụ huynh; S4-BE-03 thay bằng trạng thái gộp thật (activated > invited > expired).
        inviteStatus: 'not_invited' as const,
        // Ghi ở `putFeeOverride`: null khi không còn mức riêng nên khác null = hiện nhãn "Giá riêng".
        feeOverride: r.feeOverride as FeeOverride | null,
        // Trigger CSDL giữ tối đa 2 phụ huynh chưa gỡ cho mỗi học viên.
        guardians: gs
          .filter((g) => g.studentId === r.studentId)
          .map((g) => ({
            id: g.id,
            fullName: g.fullName,
            relation: g.relation as 'father' | 'mother' | 'guardian',
            inviteStatus: 'not_invited' as const, // shortcut: như trên, S4-BE-03
            latestInvite: null,
          })),
      })),
    };
  }

  /**
   * Thay toàn bộ mức riêng của một ghi danh (US-1.3 AC1). Lưu đúng dạng hợp đồng (`FeeOverride`); trường `null` =
   * kế thừa lớp, nên thứ tự học sinh > lớp > mặc định do `InvoiceCalculator` (override > classRules > DEFAULT) áp.
   * Chỉ ghi ghi danh: hóa đơn đã phát hành không bị đụng tới (US-1.2 AC4).
   */
  async putFeeOverride(
    tx: Tx,
    tenantId: string,
    enrollmentId: string,
    body: PutFeeOverrideRequest,
  ): Promise<FeeOverrideResult> {
    const [en] = await tx
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.id, enrollmentId),
        ),
      )
      .for('update');
    if (!en) throw new AppException('NOT_FOUND');
    if (en.leftOn) throw new AppException('CONFLICT_STALE');
    const [cls] = await tx
      .select({ feeType: classes.feeType })
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, en.classId)));

    const fee: FeeOverride = {
      feeAmount: body.feeAmount ?? null,
      chargeExcused: body.chargeExcused ?? null,
      chargeUnexcused: body.chargeUnexcused ?? null,
      deductCancelled: body.deductCancelled ?? null,
      installments: body.installments ?? null,
      discounts: body.discounts ?? [],
    };
    const errors: Record<string, string[]> = {};
    if (fee.feeAmount !== null && !cls?.feeType) {
      errors.feeAmount = ['Lớp chưa có học phí để đặt mức riêng.'];
    }
    if (
      fee.installments !== null &&
      fee.installments > 1 &&
      cls?.feeType !== 'course'
    ) {
      errors.installments = ['Chỉ khóa trọn gói mới chia đợt.'];
    }
    if (Object.keys(errors).length) {
      throw new AppException('VALIDATION_FAILED', undefined, errors);
    }
    const empty = Object.values(fee).every((v) =>
      Array.isArray(v) ? v.length === 0 : v === null,
    );
    await tx
      .update(enrollments)
      .set({ feeOverride: empty ? null : fee })
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.id, enrollmentId),
        ),
      );
    return {
      enrollmentId,
      studentId: en.studentId,
      classId: en.classId,
      feeOverride: empty ? null : fee,
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
