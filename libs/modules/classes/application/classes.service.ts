import { Injectable } from '@nestjs/common';
import { PlanService } from '@teachhub/modules/subscription';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import {
  AppException,
  type PageQuery,
  type Paginated,
  paginated,
  toLimitOffset,
  uuidv7,
} from '@teachhub/core';
import {
  acknowledgements,
  branches,
  classes,
  enrollments,
  students,
  type Tx,
  writeAudit,
} from '@teachhub/db';
import {
  ScheduleRulesReader,
  ScheduleService,
} from '@teachhub/modules/schedule';
import type { FeeRules, FeeType } from '@teachhub/modules/billing';
import {
  classFeeErrors,
  dropTypeBoundFields,
  type OverrideShape,
  resolveFeeRules,
} from '../domain/class-fee.js';
import { classDraftErrors } from '../domain/class-rules.js';
import { mergeNotificationSettings } from '../domain/notification-settings.js';
import { classWarnings } from '../domain/class-warnings.js';
import type {
  Class,
  ClassCreated,
  CreateClassRequest,
  UpdateClassRequest,
} from '../http/classes.schemas.js';

type ClassRow = typeof classes.$inferSelect;

/** Quy tắc đã lưu khi PATCH không gửi `feeRules`: chỉ trọn khóa giữ số đợt, kiểu khác đưa về 1 trước khi kiểm. */
const keepStoredRules = (
  stored: Partial<FeeRules> | null,
  type: FeeType | null,
): Partial<FeeRules> | null =>
  stored && type !== 'course' ? { ...stored, installments: 1 } : stored;

/**
 * Lớp của tenant (US-1.1). RLS (`classes_staff_all`) là lớp phòng thủ thứ hai; mọi truy vấn vẫn lọc `tenant_id`
 * tường minh. Lớp của tenant khác → không thấy dòng → NOT_FOUND (không phân biệt "không tồn tại").
 */
@Injectable()
export class ClassesService {
  constructor(
    private readonly rules: ScheduleRulesReader,
    private readonly schedule: ScheduleService,
    private readonly planService: PlanService,
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
    // Hạn mức gói (US-0.7 AC1): lớp đang hoạt động vượt max_active_classes → 402 PLAN_LIMIT_EXCEEDED.
    await this.planService.assertCanAdd(tx, ctx.tenantId, 'classes');
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
    return { ...created!, warnings: classWarnings(row) };
  }

  /**
   * Ghi xác nhận "Tôi đã hiểu, vẫn tạo" (US-9.3 AC3). Chỉ nhận mã đang có trong cảnh báo hiện tại của lớp; gọi lại cùng mã không
   * ghi trùng (unique tenant, kind, lớp, mã). Lớp của tenant khác → NOT_FOUND.
   */
  async acknowledgeWarning(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    id: string,
    code: string,
  ): Promise<void> {
    const [row] = await tx
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, ctx.tenantId), eq(classes.id, id)));
    if (!row) throw new AppException('NOT_FOUND');
    if (!classWarnings(row).some((w) => w.code === code)) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        code: ['Lớp này không có cảnh báo này để xác nhận.'],
      });
    }
    await tx
      .insert(acknowledgements)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        kind: 'class_warning',
        entityId: id,
        code,
        userId: ctx.userId,
      })
      .onConflictDoNothing();
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
    const { feeType, feeAmount, feeRules, notificationSettings, ...rest } =
      body;
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
          : keepStoredRules(cur.feeRules as Partial<FeeRules> | null, nextType);
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
    const settingsPatch = notificationSettings
      ? {
          notificationSettings: mergeNotificationSettings(
            cur.notificationSettings,
            notificationSettings,
          ),
        }
      : {};
    const set = { ...patch, ...feePatch, ...settingsPatch };
    // Patch rỗng: Drizzle không nhận `set({})`, không có gì để ghi thì giữ nguyên dòng.
    const [row] = Object.keys(set).length
      ? await tx
          .update(classes)
          .set(set)
          .where(and(eq(classes.tenantId, tenantId), eq(classes.id, id)))
          .returning()
      : [cur];
    // Đổi hoặc bỏ kiểu học phí: số tiền / số đợt riêng của học viên mang nghĩa theo kiểu cũ, bỏ để không tính sai im lặng.
    if (cur.feeType !== null && nextType !== cur.feeType) {
      await this.dropOverrideFee(tx, tenantId, id);
    }
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

  /** Xóa `feeAmount`, `installments` khỏi mức riêng của ghi danh mở; mức riêng thành rỗng thì về null. */
  private async dropOverrideFee(
    tx: Tx,
    tenantId: string,
    classId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: enrollments.id, feeOverride: enrollments.feeOverride })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.classId, classId),
          isNull(enrollments.leftOn),
          isNotNull(enrollments.feeOverride),
        ),
      );
    for (const r of rows) {
      const before = r.feeOverride as OverrideShape;
      const after = dropTypeBoundFields(before);
      if (before.feeAmount === null && before.installments === null) continue;
      await tx
        .update(enrollments)
        .set({ feeOverride: after })
        .where(
          and(eq(enrollments.tenantId, tenantId), eq(enrollments.id, r.id)),
        );
      await writeAudit(tx, {
        tenantId,
        entity: 'enrollments',
        entityId: r.id,
        action: 'update',
        before: { feeOverride: before },
        after: { feeOverride: after },
      });
    }
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
      notificationSettings: mergeNotificationSettings(r.notificationSettings),
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
