import { Injectable, Logger } from '@nestjs/common';
import {
  and,
  between,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { MAX_VND, uuidv7 } from '@teachhub/core';
import {
  attendance,
  billingPeriods,
  classes,
  enrollments,
  invoiceLines,
  invoices,
  recordOutboxEvent,
  sessions,
  students,
  tenants,
  TxService,
  type Tx,
} from '@teachhub/db';
import { JobRuns } from '@teachhub/infra';
import { localDate } from '@teachhub/modules/schedule';
import {
  type ClassFee,
  type ClassSession,
  computeEnrollmentInvoice,
  type PeriodDates,
  parseBillingSettings,
  latestClosablePeriod,
} from '../domain/billing-period.js';
import type { FeeType } from '../domain/invoice-calculator.js';

export const JOB_BILLING_CLOSE = 'billing.close';
/** Tên sự kiện outbox báo giáo viên bản nháp đã sẵn sàng (Technical Spec §3). */
export const BILLING_DRAFTS_READY = 'billing_drafts_ready';
export interface BillingDraftsReadyPayload extends Record<string, unknown> {
  periodId: string;
  periodMonth: string;
  draftCount: number;
  draftTotalAmount: number;
}

const LINE_CHUNK = 1000;
/** Mã lỗi Postgres (vd. 23505) của lỗi gốc, hoặc tên lỗi: không log message (có thể chứa dữ liệu học viên). */
const errorCode = (e: unknown): string => {
  const base = e instanceof Error ? (e.cause ?? e) : e;
  const code = (base as { code?: unknown }).code;
  return typeof code === 'string' ? code : ((base as Error)?.name ?? 'unknown');
};

/**
 * Job 02:00 tạo kỳ thu và bản nháp hóa đơn (S5-BE-05, US-7.2 AC1). Chạy bằng role worker (BYPASSRLS) nên mọi truy vấn
 * lọc `tenant_id` tường minh; "hôm nay" theo múi giờ từng tenant. Mỗi tenant một giao dịch (kỳ, hóa đơn, dòng, outbox
 * cùng commit); tenant lỗi không chặn tenant khác, có lỗi thì job ghi `failed` và ném lại để BullMQ thử lại.
 *
 * Idempotent: kỳ upsert theo (tenant, tháng) rồi khóa dòng kỳ và kiểm lại dưới khóa; học viên đã có hóa đơn nào trong kỳ (nháp, đã phát
 * hành hay đã hủy) thì bỏ qua; `invoices_draft_uq` là lớp chặn cuối. Chạy lại cùng ngày không tạo gì mới và không ghi outbox.
 *
 * Quy tắc kỳ, học viên tạm nghỉ/đã rời, buổi chưa điểm danh: xem đầu `domain/billing-period.ts` (D1–D5).
 */
@Injectable()
export class BillingCloseJob {
  private readonly log = new Logger(BillingCloseJob.name);

  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  /**
   * Trả số bản nháp đã tạo. `now` do cron cố định theo thời điểm tạo job để lần BullMQ thử lại vẫn tính đúng kỳ.
   */
  run(now = new Date()): Promise<number> {
    return this.runs.track(JOB_BILLING_CLOSE, async () => {
      const tenantRows = await this.tx.run({ userId: null }, (t) =>
        t
          .select({
            id: tenants.id,
            tz: tenants.timezone,
            settings: tenants.settings,
          })
          .from(tenants)
          .where(isNull(tenants.deletedAt)),
      );
      let created = 0;
      let failed = 0;
      for (const tenant of tenantRows) {
        const period = latestClosablePeriod(
          localDate(now, tenant.tz),
          parseBillingSettings(tenant.settings),
        );
        try {
          created += await this.tx.run({ userId: null }, (t) =>
            this.closeTenant(t, tenant.id, period),
          );
        } catch (e) {
          failed += 1;
          this.log.error(`tenant ${tenant.id}: ${errorCode(e)}`);
        }
      }
      if (failed) throw new Error(`${failed} tenant không tạo được bản nháp`);
      return created;
    });
  }

  /**
   * Một tenant trong một giao dịch; trả số bản nháp mới. Kỳ đã có thì chỉ chạy lại đúng ngày chốt (bù học viên mới);
   * lỡ ngày chốt thì kỳ chưa có vẫn được tạo ở lần chạy sau (catch-up). Kỳ chỉ được tạo khi có bản nháp.
   */
  private async closeTenant(
    t: Tx,
    tenantId: string,
    period: PeriodDates,
  ): Promise<number> {
    const periodWhere = and(
      eq(billingPeriods.tenantId, tenantId),
      eq(billingPeriods.periodMonth, period.periodMonth),
    );
    const [known] = await t.select().from(billingPeriods).where(periodWhere);
    if (known && !period.isCloseDay) return 0;

    const classRows = await t
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), isNotNull(classes.feeType)));
    if (!classRows.length) return 0;
    const classIds = classRows.map((c) => c.id);
    const courseIds = classRows
      .filter((c) => c.feeType === 'course')
      .map((c) => c.id);

    const enrollmentRows = await t
      .select({
        classId: enrollments.classId,
        studentId: enrollments.studentId,
        joinedOn: enrollments.joinedOn,
        leftOn: enrollments.leftOn,
        feeOverride: enrollments.feeOverride,
        paused: sql<boolean>`${students.status} = 'paused'`,
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
          inArray(enrollments.classId, classIds),
          lte(enrollments.joinedOn, period.periodEnd),
          or(
            isNull(enrollments.leftOn),
            gt(enrollments.leftOn, period.periodMonth),
          ),
          ne(students.status, 'left'),
        ),
      );
    if (!enrollmentRows.length) return 0;

    const invoicedStudents = async (periodId: string) =>
      new Set(
        (
          await t
            .select({ studentId: invoices.studentId })
            .from(invoices)
            .where(
              and(
                eq(invoices.tenantId, tenantId),
                eq(invoices.periodId, periodId),
              ),
            )
        ).map((r) => r.studentId),
      );
    const existing = known
      ? await invoicedStudents(known.id)
      : new Set<string>();

    // Lớp trọn khóa cần mọi buổi (đếm tổng và còn lại); lớp khác chỉ cần buổi trong tháng của kỳ.
    const sessionRows = await t
      .select({
        id: sessions.id,
        classId: sessions.classId,
        date: sessions.sessionDate,
        status: sessions.status,
        isMakeup: sessions.isMakeup,
        makeupOf: sessions.makeupOf,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          inArray(sessions.classId, classIds),
          courseIds.length
            ? or(
                inArray(sessions.classId, courseIds),
                between(
                  sessions.sessionDate,
                  period.periodMonth,
                  period.periodEnd,
                ),
              )
            : between(
                sessions.sessionDate,
                period.periodMonth,
                period.periodEnd,
              ),
        ),
      );
    const sessionsByClass = new Map<string, ClassSession[]>();
    const dateOf = new Map<string, string>();
    for (const s of sessionRows) {
      dateOf.set(s.id, s.date);
      const list = sessionsByClass.get(s.classId) ?? [];
      list.push({ ...s, status: s.status as ClassSession['status'] });
      sessionsByClass.set(s.classId, list);
    }

    // Điểm danh của các buổi trong kỳ, theo học viên.
    const periodSessionIds = sessionRows
      .filter((s) => s.date >= period.periodMonth && s.date <= period.periodEnd)
      .map((s) => s.id);
    const attByStudent = new Map<string, Map<string, string>>();
    for (let i = 0; i < periodSessionIds.length; i += 5000) {
      const rows = await t
        .select({
          studentId: attendance.studentId,
          sessionId: attendance.sessionId,
          status: attendance.status,
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.tenantId, tenantId),
            inArray(attendance.sessionId, periodSessionIds.slice(i, i + 5000)),
          ),
        );
      for (const r of rows) {
        const m = attByStudent.get(r.studentId) ?? new Map<string, string>();
        m.set(r.sessionId, r.status);
        attByStudent.set(r.studentId, m);
      }
    }

    // Gộp mọi lớp của một học viên thành một hóa đơn (lớp theo tên cho thứ tự dòng ổn định).
    const classById = new Map(classRows.map((c) => [c.id, c]));
    type Draft = {
      studentId: string;
      lines: (typeof invoiceLines.$inferInsert)[];
      total: number;
      courses: { no: number; count: number }[];
    };
    const drafts = new Map<string, Draft>();
    const ordered = [...enrollmentRows].sort(
      (a, b) =>
        (classById.get(a.classId)?.name ?? '').localeCompare(
          classById.get(b.classId)?.name ?? '',
        ) || a.studentId.localeCompare(b.studentId),
    );
    for (const enr of ordered) {
      if (existing.has(enr.studentId)) continue;
      const c = classById.get(enr.classId);
      if (!c) continue;
      const fee: ClassFee = {
        className: c.name,
        feeType: c.feeType as FeeType,
        feeAmount: c.feeAmount!,
        feeRules: c.feeRules,
      };
      const r = computeEnrollmentInvoice(
        fee,
        enr,
        period,
        sessionsByClass.get(c.id) ?? [],
        attByStudent.get(enr.studentId) ?? new Map(),
        { paused: enr.paused },
      );
      if (!r || !r.result.lines.length) continue;
      const d = drafts.get(enr.studentId) ?? {
        studentId: enr.studentId,
        lines: [],
        total: 0,
        courses: [],
      };
      for (const l of r.result.lines) {
        d.lines.push({
          id: uuidv7(),
          tenantId,
          invoiceId: '', // gán khi có id hóa đơn
          position: d.lines.length + 1,
          kind: l.kind,
          description: l.description,
          amount: l.amount,
          charged: l.charged ?? true,
          notChargedReason:
            l.kind === 'session' && l.charged === false ? l.reason! : null,
          sessionId: l.sessionId ?? null,
          sessionDate: l.sessionId ? (dateOf.get(l.sessionId) ?? null) : null,
          className: c.name,
          adjustmentReason: null,
        });
      }
      // Tổng hóa đơn = Σ tổng từng ghi danh (calculator đã cắt về ≥ 0) rồi cắt lần cuối cùng với dòng điều chỉnh khi sửa.
      d.total += r.result.total;
      if (r.installmentNo && r.installmentCount)
        d.courses.push({ no: r.installmentNo, count: r.installmentCount });
      drafts.set(enr.studentId, d);
    }
    if (!drafts.size) return 0;

    // Từ đây ghi: tạo kỳ nếu chưa có rồi khóa dòng kỳ để hai lần chạy chồng nhau nối tiếp nhau, và kiểm lại học viên đã có
    // hóa đơn dưới khóa.
    await t
      .insert(billingPeriods)
      .values({
        id: uuidv7(),
        tenantId,
        periodMonth: period.periodMonth,
        closeDate: period.closeDate,
        dueDate: period.dueDate,
      })
      .onConflictDoNothing();
    const [bp] = await t
      .select()
      .from(billingPeriods)
      .where(periodWhere)
      .for('update');
    if (!bp) throw new Error('không tạo được kỳ thu');
    const invoiced = await invoicedStudents(bp.id);

    let draftCount = 0;
    let draftTotalAmount = 0;
    const lineRows: (typeof invoiceLines.$inferInsert)[] = [];
    for (const d of drafts.values()) {
      if (invoiced.has(d.studentId)) continue;
      if (d.total > MAX_VND) {
        // Một hóa đơn vượt trần không được làm hỏng cả tenant mỗi đêm: bỏ qua, chỉ log mã lỗi và id học viên.
        this.log.error(
          `tenant ${tenantId} học viên ${d.studentId}: TOTAL_EXCEEDS_CAP`,
        );
        continue;
      }
      const id = uuidv7();
      // Thông tin đợt chỉ ghi khi hóa đơn có đúng một lớp trọn khóa.
      const course = d.courses.length === 1 ? d.courses[0]! : null;
      const [row] = await t
        .insert(invoices)
        .values({
          id,
          tenantId,
          periodId: bp.id,
          studentId: d.studentId,
          totalAmount: d.total,
          clampedAmount: 0,
          installmentNo: course?.no ?? null,
          installmentCount: course?.count ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: invoices.id });
      if (!row) continue; // đã có bản nháp (chạy chồng): bỏ qua
      draftCount += 1;
      draftTotalAmount += d.total;
      for (const l of d.lines) lineRows.push({ ...l, invoiceId: id });
    }
    for (let i = 0; i < lineRows.length; i += LINE_CHUNK)
      await t.insert(invoiceLines).values(lineRows.slice(i, i + LINE_CHUNK));
    if (!draftCount) return 0;

    // Kỳ đã `closed` mà có bản nháp có tiền mới (học viên vào muộn) thì quay lại `drafting`.
    if (bp.status === 'closed' && draftTotalAmount > 0)
      await t
        .update(billingPeriods)
        .set({ status: 'drafting' })
        .where(
          and(
            eq(billingPeriods.tenantId, tenantId),
            eq(billingPeriods.id, bp.id),
          ),
        );

    const payload: BillingDraftsReadyPayload = {
      periodId: bp.id,
      periodMonth: bp.periodMonth,
      draftCount,
      draftTotalAmount,
    };
    await recordOutboxEvent(t, {
      tenantId,
      type: BILLING_DRAFTS_READY,
      payload,
    });
    return draftCount;
  }
}
