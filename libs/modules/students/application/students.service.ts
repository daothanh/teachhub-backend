import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  AppException,
  type PageQuery,
  type Paginated,
  paginated,
  toLimitOffset,
  uuidv7,
} from '@teachhub/core';
import { enrollments, guardians, students, type Tx } from '@teachhub/db';
import { planGuardianSync } from '../domain/guardian-sync.js';
import type {
  CreateStudentRequest,
  Student,
  UpdateStudentRequest,
} from '../http/students.schemas.js';

type StudentRow = typeof students.$inferSelect;
type GuardianIn = CreateStudentRequest['guardians'][number];

const MAX_CANDIDATES = 5;
/** Chuẩn hóa như cột `full_name_unaccent` (cùng hàm CSDL) để so khớp và tìm kiếm. */
const normalized = (v: string) => sql`lower(app_private.f_unaccent(${v}))`;
const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

/**
 * Học viên của tenant (US-1.4). Không log họ tên, SĐT, body guardians; mọi truy vấn lọc `tenant_id` tường minh
 * (RLS là lớp thứ hai).
 */
@Injectable()
export class StudentsService {
  async list(
    tx: Tx,
    tenantId: string,
    query: PageQuery & {
      status: Student['status'];
      classId?: string | undefined;
      q?: string | undefined;
    },
  ): Promise<Paginated<Student>> {
    const where = and(
      eq(students.tenantId, tenantId),
      eq(students.status, query.status),
      query.q
        ? sql`${students.fullNameUnaccent} like '%' || ${normalized(escapeLike(query.q))} || '%'`
        : undefined,
      query.classId
        ? inArray(
            students.id,
            tx
              .select({ id: enrollments.studentId })
              .from(enrollments)
              .where(
                and(
                  eq(enrollments.tenantId, tenantId),
                  eq(enrollments.classId, query.classId),
                  isNull(enrollments.leftOn),
                ),
              ),
          )
        : undefined,
    );
    const { limit, offset } = toLimitOffset(query);
    const [rows, [total]] = await Promise.all([
      tx
        .select()
        .from(students)
        .where(where)
        .orderBy(asc(students.fullNameUnaccent), asc(students.id))
        .limit(limit)
        .offset(offset),
      tx.select({ n: count() }).from(students).where(where),
    ]);
    return paginated(
      await this.hydrate(tx, tenantId, rows),
      total?.n ?? 0,
      query,
    );
  }

  async create(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    body: CreateStudentRequest,
  ): Promise<Student> {
    // Học viên mới chưa có phụ huynh nào để trỏ tới → mọi `guardians[].id` đều không hợp lệ.
    const plan = planGuardianSync([], body.guardians);
    if (Object.keys(plan.errors).length) {
      throw new AppException('VALIDATION_FAILED', undefined, plan.errors);
    }
    if (!body.confirmNew) {
      const candidates = await this.duplicates(tx, ctx.tenantId, body);
      if (candidates.length) {
        throw new AppException('STUDENT_POSSIBLE_DUPLICATE', { candidates });
      }
    }
    // shortcut: chưa kiểm hạn mức gói (max_active_students, US-0.7); PlanLimitService vào cùng US-0.7 → kiểm ở đây
    // trước khi insert và ném PLAN_LIMIT_EXCEEDED.
    const [row] = await tx
      .insert(students)
      .values({
        id: body.id ?? uuidv7(),
        tenantId: ctx.tenantId,
        fullName: body.fullName,
        dob: body.dob ?? null,
        school: body.school ?? null,
        schoolClass: body.schoolClass ?? null,
        note: body.note ?? null,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning();
    // `id` do client gửi đã có (kể cả ở tenant khác): không tiết lộ, coi như dữ liệu cũ.
    if (!row) throw new AppException('CONFLICT_STALE');
    await this.insertGuardians(tx, ctx.tenantId, row.id, plan.toCreate);
    return (await this.hydrate(tx, ctx.tenantId, [row]))[0]!;
  }

  async update(
    tx: Tx,
    tenantId: string,
    id: string,
    body: UpdateStudentRequest,
  ): Promise<Student> {
    const [cur] = await tx
      .select()
      .from(students)
      .where(and(eq(students.tenantId, tenantId), eq(students.id, id)))
      // Không khóa khóa chính: trigger giới hạn phụ huynh (FOR NO KEY UPDATE) và FK từ ghi danh không chặn nhau.
      .for('no key update');
    if (!cur) throw new AppException('NOT_FOUND');

    if (body.guardians !== undefined) {
      const existing = await tx
        .select({ id: guardians.id })
        .from(guardians)
        .where(
          and(
            eq(guardians.tenantId, tenantId),
            eq(guardians.studentId, id),
            isNull(guardians.deletedAt),
          ),
        );
      const plan = planGuardianSync(
        existing.map((g) => g.id),
        body.guardians,
      );
      if (Object.keys(plan.errors).length) {
        throw new AppException('VALIDATION_FAILED', undefined, plan.errors);
      }
      // Gỡ trước, thêm sau: trigger giới hạn 2 phụ huynh chỉ đếm dòng chưa gỡ.
      if (plan.toRemove.length) {
        await tx
          .update(guardians)
          .set({ deletedAt: sql`now()` })
          .where(
            and(
              eq(guardians.tenantId, tenantId),
              inArray(guardians.id, plan.toRemove),
            ),
          );
      }
      for (const g of plan.toUpdate) {
        // Lọc cả tenant_id và student_id: id của học viên/tenant khác không bao giờ khớp.
        await tx
          .update(guardians)
          .set({
            fullName: g.fullName,
            relation: g.relation,
            phone: g.phone ?? null,
            email: g.email ?? null,
          })
          .where(
            and(
              eq(guardians.id, g.id),
              eq(guardians.tenantId, tenantId),
              eq(guardians.studentId, id),
              isNull(guardians.deletedAt),
            ),
          );
      }
      await this.insertGuardians(tx, tenantId, id, plan.toCreate);
    }

    const patch = {
      fullName: body.fullName,
      dob: body.dob,
      school: body.school,
      schoolClass: body.schoolClass,
      note: body.note,
    };
    const set = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    const [row] = Object.keys(set).length
      ? await tx
          .update(students)
          .set(set)
          .where(and(eq(students.tenantId, tenantId), eq(students.id, id)))
          .returning()
      : [cur];
    return (await this.hydrate(tx, tenantId, [row!]))[0]!;
  }

  /** Ứng viên trùng: cùng họ tên (không phân biệt dấu/hoa thường) và cùng ngày sinh (cùng không có cũng tính). */
  private duplicates(
    tx: Tx,
    tenantId: string,
    body: CreateStudentRequest,
  ): Promise<
    {
      id: string;
      fullName: string;
      dob: string | null;
      school: string | null;
    }[]
  > {
    return tx
      .select({
        id: students.id,
        fullName: students.fullName,
        dob: students.dob,
        school: students.school,
      })
      .from(students)
      .where(
        and(
          eq(students.tenantId, tenantId),
          sql`${students.fullNameUnaccent} = ${normalized(body.fullName)}`,
          sql`${students.dob} is not distinct from ${body.dob ?? null}::date`,
        ),
      )
      .orderBy(asc(students.createdAt), asc(students.id))
      .limit(MAX_CANDIDATES);
  }

  private async insertGuardians(
    tx: Tx,
    tenantId: string,
    studentId: string,
    input: GuardianIn[],
  ): Promise<void> {
    if (!input.length) return;
    await tx.insert(guardians).values(
      input.map((g) => ({
        id: uuidv7(),
        tenantId,
        studentId,
        fullName: g.fullName,
        relation: g.relation,
        phone: g.phone ?? null,
        email: g.email ?? null,
      })),
    );
  }

  private async hydrate(
    tx: Tx,
    tenantId: string,
    rows: StudentRow[],
  ): Promise<Student[]> {
    const gs = rows.length
      ? await tx
          .select()
          .from(guardians)
          .where(
            and(
              eq(guardians.tenantId, tenantId),
              inArray(
                guardians.studentId,
                rows.map((r) => r.id),
              ),
              isNull(guardians.deletedAt),
            ),
          )
          .orderBy(asc(guardians.createdAt), asc(guardians.id))
      : [];
    return rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      dob: r.dob,
      school: r.school,
      schoolClass: r.schoolClass,
      note: r.note,
      status: r.status as Student['status'],
      guardians: gs
        .filter((g) => g.studentId === r.id)
        .map((g) => ({
          id: g.id,
          fullName: g.fullName,
          relation: g.relation as 'father' | 'mother' | 'guardian',
          phone: g.phone,
          email: g.email,
        })),
    }));
  }
}
