import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  AppException,
  type PageQuery,
  type Paginated,
  paginated,
  toLimitOffset,
  uuidv7,
} from '@teachhub/core';
import {
  branches,
  classes,
  enrollments,
  students,
  type Tx,
} from '@teachhub/db';
import {
  ScheduleRulesReader,
  ScheduleService,
} from '@teachhub/modules/schedule';
import type { FeeRules, FeeType } from '@teachhub/modules/billing';
import { classFeeErrors, resolveFeeRules } from '../domain/class-fee.js';
import { classDraftErrors } from '../domain/class-rules.js';
import type {
  Class,
  ClassCreated,
  CreateClassRequest,
  UpdateClassRequest,
} from '../http/classes.schemas.js';

type ClassRow = typeof classes.$inferSelect;

/**
 * Lớp của tenant (US-1.1). RLS (`classes_staff_all`) là lớp phòng thủ thứ hai; mọi truy vấn vẫn lọc `tenant_id`
 * tường minh. Lớp của tenant khác → không thấy dòng → NOT_FOUND (không phân biệt "không tồn tại").
 */
@Injectable()
export class ClassesService {
  constructor(
    private readonly rules: ScheduleRulesReader,
    private readonly schedule: ScheduleService,
  ) {}

  async list(
    tx: Tx,
    tenantId: string,
    query: PageQuery & { status: 'active' | 'archived' },
  ): Promise<Paginated<Class>> {
    const where = and(
      eq(classes.tenantId, tenantId),
      eq(classes.status, query.status),
    );
    const [rows, [total]] = await Promise.all([
      tx
        .select()
        .from(classes)
        .where(where)
        .orderBy(desc(classes.createdAt), desc(classes.id))
        .limit(toLimitOffset(query).limit)
        .offset(toLimitOffset(query).offset),
      tx.select({ n: count() }).from(classes).where(where),
    ]);
    return paginated(
      await this.hydrate(tx, tenantId, rows),
      total?.n ?? 0,
      query,
    );
  }

  async get(tx: Tx, tenantId: string, id: string): Promise<Class> {
    const [row] = await tx
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, id)));
    if (!row) throw new AppException('NOT_FOUND');
    return (await this.hydrate(tx, tenantId, [row]))[0]!;
  }

  async create(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    body: CreateClassRequest,
  ): Promise<ClassCreated> {
    // shortcut: chưa kiểm hạn mức gói (max_active_classes, US-0.7); PlanLimitService vào cùng US-0.7 → kiểm ở đây
    // trước khi insert và ném PLAN_LIMIT_EXCEEDED.
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(eq(branches.tenantId, ctx.tenantId), eq(branches.isDefault, true)),
      );
    if (!branch) throw new AppException('INTERNAL_ERROR');
    const [row] = await tx
      .insert(classes)
      .values({
        id: body.id ?? uuidv7(),
        tenantId: ctx.tenantId,
        branchId: branch.id,
        name: body.name,
        subject: body.subject,
        grade: body.grade,
        mode: body.mode,
        location: body.location ?? null,
        capacity: body.capacity ?? null,
        startDate: body.startDate,
        endDate: body.endDate ?? null,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning();
    // `id` do client gửi đã có (kể cả ở tenant khác): không tiết lộ, coi như dữ liệu cũ.
    if (!row) throw new AppException('CONFLICT_STALE');
    const [created] = await this.hydrate(tx, ctx.tenantId, [row]);
    return { ...created!, warnings: [] };
  }

  async update(
    tx: Tx,
    tenantId: string,
    id: string,
    body: UpdateClassRequest,
  ): Promise<Class> {
    const [cur] = await tx
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, id)))
      .for('update');
    if (!cur) throw new AppException('NOT_FOUND');
    if (cur.status === 'archived') throw new AppException('CONFLICT_STALE');
    const { feeType, feeAmount, feeRules, ...rest } = body;
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    ) as UpdateClassRequest;
    const merged = { ...cur, ...patch };
    const errors = classDraftErrors({
      mode: merged.mode as 'offline' | 'online',
      location: merged.location ?? null,
      startDate: merged.startDate,
      endDate: merged.endDate ?? null,
    });
    // Học phí: kiểm trên bản đã gộp. Chỉ đụng tới cột học phí khi request có gửi trường học phí.
    const feeTouched = [feeType, feeAmount, feeRules].some(
      (v) => v !== undefined,
    );
    const nextType = (
      feeType !== undefined ? feeType : cur.feeType
    ) as FeeType | null;
    const nextAmount = feeAmount !== undefined ? feeAmount : cur.feeAmount;
    // `feeRules` thiếu = giữ quy tắc đã lưu (bỏ học phí thì bỏ luôn); `null` = về mặc định; object = thay toàn bộ.
    const nextRules =
      feeRules !== undefined
        ? feeRules
        : nextType === null
          ? null
          : (cur.feeRules as Partial<FeeRules> | null);
    if (nextType !== null || nextAmount !== null || nextRules !== null) {
      Object.assign(
        errors,
        classFeeErrors({
          feeType: nextType,
          feeAmount: nextAmount,
          feeRules: nextRules,
          endDate: merged.endDate ?? null,
          scheduleRuleCount:
            nextType === 'course'
              ? ((await this.rules.byClass(tx, tenantId, [id])).get(id)
                  ?.length ?? 0)
              : 0,
        }),
      );
    }
    if (Object.keys(errors).length) {
      throw new AppException('VALIDATION_FAILED', undefined, errors);
    }
    const feePatch = feeTouched
      ? {
          feeType: nextType,
          feeAmount: nextAmount,
          feeRules: resolveFeeRules(nextType, nextRules),
        }
      : {};
    const [row] = await tx
      .update(classes)
      .set({ ...patch, ...feePatch })
      .where(and(eq(classes.tenantId, tenantId), eq(classes.id, id)))
      .returning();
    // Đổi kỳ hạn lớp → buổi dự kiến tương lai phải khớp lại (cắt phần quá hạn, sinh phần mở rộng).
    if (row!.startDate !== cur.startDate || row!.endDate !== cur.endDate) {
      await this.schedule.reconcile(
        tx,
        tenantId,
        row!,
        new Date(),
        await this.schedule.timezone(tx, tenantId),
      );
    }
    return (await this.hydrate(tx, tenantId, [row!]))[0]!;
  }

  /** Gọi lại trên lớp đã lưu trữ vẫn trả lớp hiện tại (không đổi `archivedAt`). */
  async archive(tx: Tx, tenantId: string, id: string): Promise<Class> {
    const [row] = await tx
      .update(classes)
      .set({ status: 'archived', archivedAt: sql`now()` })
      .where(
        and(
          eq(classes.tenantId, tenantId),
          eq(classes.id, id),
          eq(classes.status, 'active'),
        ),
      )
      .returning();
    if (row) return (await this.hydrate(tx, tenantId, [row]))[0]!;
    return this.get(tx, tenantId, id);
  }

  /** Ghép `enrolledCount` (ghi danh mở, học viên chưa nghỉ) và `scheduleRules` (qua cổng của module schedule). */
  private async hydrate(
    tx: Tx,
    tenantId: string,
    rows: ClassRow[],
  ): Promise<Class[]> {
    const counts = rows.length
      ? await tx
          .select({ classId: enrollments.classId, n: count() })
          .from(enrollments)
          .innerJoin(students, eq(students.id, enrollments.studentId))
          .where(
            and(
              eq(enrollments.tenantId, tenantId),
              eq(students.tenantId, tenantId),
              inArray(
                enrollments.classId,
                rows.map((r) => r.id),
              ),
              isNull(enrollments.leftOn),
              ne(students.status, 'left'),
            ),
          )
          .groupBy(enrollments.classId)
      : [];
    const enrolled = new Map(counts.map((c) => [c.classId, c.n]));
    const rules = await this.rules.byClass(
      tx,
      tenantId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      subject: r.subject,
      grade: r.grade,
      mode: r.mode as Class['mode'],
      location: r.location,
      capacity: r.capacity,
      startDate: r.startDate,
      endDate: r.endDate,
      status: r.status as Class['status'],
      enrolledCount: enrolled.get(r.id) ?? 0,
      feeType: r.feeType as FeeType | null,
      feeAmount: r.feeAmount,
      feeRules: resolveFeeRules(
        r.feeType as FeeType | null,
        r.feeRules as Partial<FeeRules> | null,
      ),
      scheduleRules: rules.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
