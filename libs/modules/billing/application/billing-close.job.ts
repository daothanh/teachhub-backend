import { Injectable, Logger } from '@nestjs/common';
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
} from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
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
  periodClosingOn,
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
 * Idempotent: kỳ upsert theo (tenant, tháng) rồi khóa dòng kỳ; học viên đã có hóa đơn nào trong kỳ (nháp, đã phát
 * hành hay đã hủy) thì bỏ qua; `invoices_draft_uq` là lớp chặn cuối. Chạy lại cùng ngày không tạo gì mới và không ghi outbox.
 *
 * shortcut: học viên `paused` bị bỏ qua; học viên không có dòng tiền nào trong kỳ (lớp theo buổi chưa có buổi) không có
 * hóa đơn. Buổi sau ngày chốt trong cùng tháng (khi `billingCloseDay` < cuối tháng) chưa dạy nên chưa vào hóa đơn nào.
 */
@Injectable()
export class BillingCloseJob {
  private readonly log = new Logger(BillingCloseJob.name);

  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  /** Trả số bản nháp đã tạo. */
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
        const period = periodClosingOn(
          localDate(now, tenant.tz),
          parseBillingSettings(tenant.settings),
        );
        if (!period) continue;
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

  /** Một tenant trong một giao dịch; trả số bản nháp mới. */
  private async closeTenant(
    t: Tx,
    tenantId: string,
    period: PeriodDates,
  ): Promise<number> {
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
      .where(
        and(
          eq(billingPeriods.tenantId, tenantId),
          eq(billingPeriods.periodMonth, period.periodMonth),
        ),
      )
      .for('update');
    if (!bp) throw new Error('không tạo được kỳ thu');

    const classRows = await t
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), isNotNull(classes.feeType)));
    if (!classRows.length) return 0;
    const classIds = classRows.map((c) => c.id);

    const enrollmentRows = await t
      .select({
        classId: enrollments.classId,
        studentId: enrollments.studentId,
        joinedOn: enrollments.joinedOn,
        leftOn: enrollments.leftOn,
        feeOverride: enrollments.feeOverride,
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
          ne(students.status, 'paused'),
        ),
      );
    if (!enrollmentRows.length) return 0;

    const existing = new Set(
      (
        await t
          .select({ studentId: invoices.studentId })
          .from(invoices)
          .where(
            and(eq(invoices.tenantId, tenantId), eq(invoices.periodId, bp.id)),
          )
      ).map((r) => r.studentId),
    );

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
      clamped: number;
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
      const c = classById.get(enr.classId)!;
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
      );
      if (!r || !r.result.lines.length) continue;
      const d = drafts.get(enr.studentId) ?? {
        studentId: enr.studentId,
        lines: [],
        total: 0,
        clamped: 0,
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
      d.total += r.result.total;
      d.clamped += r.result.creditCarriedForward;
      if (r.installmentNo && r.installmentCount)
        d.courses.push({ no: r.installmentNo, count: r.installmentCount });
      drafts.set(enr.studentId, d);
    }
    if (!drafts.size) return 0;

    let draftCount = 0;
    let draftTotalAmount = 0;
    const lineRows: (typeof invoiceLines.$inferInsert)[] = [];
    for (const d of drafts.values()) {
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
          clampedAmount: d.clamped,
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
