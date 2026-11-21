import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  AppException,
  guardianInviteStatus,
  toLatestInvite,
  mergeInviteStatus,
  uuidv7,
} from '@teachhub/core';
import {
  classes,
  enrollments,
  guardians,
  latestInvitesByGuardian,
  students,
  tenants,
  type Tx,
  writeAudit,
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
    // Không kiểm hạn mức gói ở đây: ghi danh không tăng số học sinh đang học (học sinh đã được tính lúc tạo, US-0.7).
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
            userId: guardians.userId,
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
    const latest = await latestInvitesByGuardian(
      tx,
      tenantId,
      gs.map((g) => g.id),
    );
    const now = new Date();
    return {
      items: rows.map((r) => {
        // Trigger CSDL giữ tối đa 2 phụ huynh chưa gỡ cho mỗi học viên.
        const guardianItems = gs
          .filter((g) => g.studentId === r.studentId)
          .map((g) => ({
            id: g.id,
            fullName: g.fullName,
            relation: g.relation as 'father' | 'mother' | 'guardian',
            inviteStatus: guardianInviteStatus(g, latest.get(g.id), now),
            latestInvite: toLatestInvite(latest.get(g.id)),
          }));
        return {
          ...r,
          studentStatus: r.studentStatus as 'active' | 'paused',
          // Ghi ở `putFeeOverride`: null khi không còn mức riêng nên khác null = hiện nhãn "Giá riêng".
          feeOverride: r.feeOverride as FeeOverride | null,
          inviteStatus: mergeInviteStatus(
            guardianItems.map((g) => g.inviteStatus),
          ),
          guardians: guardianItems,
        };
      }),
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
    const find = () =>
      tx
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.tenantId, tenantId),
            eq(enrollments.id, enrollmentId),
          ),
        );
    const [probe] = await find();
    if (!probe) throw new AppException('NOT_FOUND');
    // Cùng thứ tự khóa với PATCH lớp (lớp trước, ghi danh sau): đọc `feeType` không bị đổi giữa chừng.
    const [cls] = await tx
      .select({ feeType: classes.feeType })
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, probe.classId)))
      .for('share');
    const [en] = await find().for('update');
    if (!en) throw new AppException('NOT_FOUND');
    if (en.leftOn) throw new AppException('CONFLICT_STALE');

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
    await writeAudit(tx, {
      tenantId,
      entity: 'enrollments',
      entityId: enrollmentId,
      action: 'update',
      before: { feeOverride: en.feeOverride },
      after: { feeOverride: empty ? null : fee },
    });
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
