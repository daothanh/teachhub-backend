import {
  and,
  between,
  eq,
  inArray,
  lt,
  ne,
  gte,
  isNotNull,
  sql,
} from 'drizzle-orm';
import {
  attendance,
  billingPeriods,
  enrollments,
  invoiceLines,
  invoices,
  sessions,
  studentLedger,
  type Tx,
} from '@teachhub/db';
import {
  type ClassFee,
  type ClassSession,
  computeEnrollmentInvoice,
  monthEnd,
} from '../domain/billing-period.js';
import {
  diffSessionCharges,
  type PrevAdjustment,
  type RecalculatedSession,
} from '../domain/carry-over.js';
import type { FeeType } from '../domain/invoice-calculator.js';

/** Hóa đơn đã phát hành mới được so điểm danh (nháp/hủy không có "đã phát hành"). */
const ISSUED = ['issued', 'partially_paid', 'paid', 'pending_confirmation'];
/** Hóa đơn còn nợ để chuyển kỳ (không gồm đã `paid`, nháp, hủy). */
const OPEN = ['issued', 'partially_paid', 'pending_confirmation'];
/** shortcut: chỉ so điểm danh các kỳ trong 12 tháng gần nhất để chi phí mỗi đêm có trần; sửa điểm danh cũ hơn thì không tự điều chỉnh. */
export const PREV_ADJUSTMENT_LOOKBACK_MONTHS = 12;
const CHUNK = 5000;

const monthsBack = (monthStart: string, n: number): string => {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 10);
};

export interface OpenInvoice {
  id: string;
  periodMonth: string;
  remaining: number;
}

/**
 * Khóa (FOR UPDATE, theo id) rồi đọc lại các hóa đơn còn nợ của học viên ở kỳ trước `periodMonth`: ghi thanh toán song song
 * cùng khóa nên số còn nợ đọc ở đây là số đã commit và không ai ghi thêm cho tới hết giao dịch.
 */
export async function lockOpenInvoices(
  t: Tx,
  tenantId: string,
  studentId: string,
  periodMonth: string,
): Promise<OpenInvoice[]> {
  const rows = await t
    .select({
      id: invoices.id,
      total: invoices.totalAmount,
      paid: invoices.paidAmount,
      carried: invoices.carriedAmount,
      periodMonth: billingPeriods.periodMonth,
    })
    .from(invoices)
    .innerJoin(
      billingPeriods,
      and(
        eq(billingPeriods.tenantId, invoices.tenantId),
        eq(billingPeriods.id, invoices.periodId),
      ),
    )
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.studentId, studentId),
        inArray(invoices.status, OPEN),
        lt(billingPeriods.periodMonth, periodMonth),
      ),
    )
    .orderBy(invoices.id)
    .for('update', { of: invoices });
  return rows
    .map((r) => ({
      id: r.id,
      periodMonth: r.periodMonth,
      remaining: Math.max(0, r.total - r.paid - r.carried),
    }))
    .filter((r) => r.remaining > 0);
}

/** Số dư sổ học viên: Σ(debit − credit); dương = nợ, âm = trả thừa. */
export async function ledgerBalance(
  t: Tx,
  tenantId: string,
  studentId: string,
): Promise<number> {
  const [r] = await t
    .select({
      n: sql<string>`coalesce(sum(${studentLedger.debit} - ${studentLedger.credit}), 0)::text`,
    })
    .from(studentLedger)
    .where(
      and(
        eq(studentLedger.tenantId, tenantId),
        eq(studentLedger.studentId, studentId),
      ),
    );
  return Number(r?.n ?? 0);
}

/**
 * Chênh lệch điểm danh sửa sau phát hành cho các học viên của đợt tạo nháp mới (US-3.3 AC4): tính lại từng hóa đơn đã phát hành
 * trong 12 tháng bằng `computeEnrollmentInvoice` (cùng calculator lúc chốt) và so với dòng buổi đã phát hành.
 * Chỉ lớp theo buổi có dòng buổi; học phí tháng/trọn khóa không phụ thuộc điểm danh.
 */
export async function loadPrevAdjustments(
  t: Tx,
  tenantId: string,
  periodMonth: string,
  studentIds: string[],
  classById: ReadonlyMap<
    string,
    {
      id: string;
      name: string;
      feeType: string | null;
      feeAmount: number | null;
      feeRules: unknown;
    }
  >,
): Promise<Map<string, PrevAdjustment[]>> {
  const out = new Map<string, PrevAdjustment[]>();
  const from = monthsBack(periodMonth, PREV_ADJUSTMENT_LOOKBACK_MONTHS);
  const perSession = [...classById.values()].filter(
    (c) => c.feeType === 'per_session',
  );
  if (!studentIds.length || !perSession.length) return out;

  const old: { id: string; studentId: string; periodMonth: string }[] = [];
  for (let i = 0; i < studentIds.length; i += CHUNK)
    old.push(
      ...(await t
        .select({
          id: invoices.id,
          studentId: invoices.studentId,
          periodMonth: billingPeriods.periodMonth,
        })
        .from(invoices)
        .innerJoin(
          billingPeriods,
          and(
            eq(billingPeriods.tenantId, invoices.tenantId),
            eq(billingPeriods.id, invoices.periodId),
          ),
        )
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            inArray(invoices.studentId, studentIds.slice(i, i + CHUNK)),
            inArray(invoices.status, ISSUED),
            lt(billingPeriods.periodMonth, periodMonth),
            gte(billingPeriods.periodMonth, from),
          ),
        )),
    );
  if (!old.length) return out;
  const oldStudents = [...new Set(old.map((o) => o.studentId))];

  // Dòng buổi đã phát hành, theo hóa đơn.
  const issued = new Map<string, Map<string, number>>();
  for (let i = 0; i < old.length; i += CHUNK) {
    const rows = await t
      .select({
        invoiceId: invoiceLines.invoiceId,
        sessionId: invoiceLines.sessionId,
        amount: invoiceLines.amount,
      })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.tenantId, tenantId),
          inArray(
            invoiceLines.invoiceId,
            old.slice(i, i + CHUNK).map((o) => o.id),
          ),
          eq(invoiceLines.kind, 'session'),
          isNotNull(invoiceLines.sessionId),
        ),
      );
    for (const r of rows) {
      const m = issued.get(r.invoiceId) ?? new Map<string, number>();
      m.set(r.sessionId!, (m.get(r.sessionId!) ?? 0) + r.amount);
      issued.set(r.invoiceId, m);
    }
  }

  // Phần đã điều chỉnh ở các hóa đơn sau (không tính hóa đơn hủy), theo học viên.
  const adjusted = new Map<string, Map<string, number>>();
  for (let i = 0; i < oldStudents.length; i += CHUNK) {
    const rows = await t
      .select({
        studentId: invoices.studentId,
        sessionId: invoiceLines.sessionId,
        amount: invoiceLines.amount,
      })
      .from(invoiceLines)
      .innerJoin(
        invoices,
        and(
          eq(invoices.tenantId, invoiceLines.tenantId),
          eq(invoices.id, invoiceLines.invoiceId),
        ),
      )
      .where(
        and(
          eq(invoiceLines.tenantId, tenantId),
          inArray(invoices.studentId, oldStudents.slice(i, i + CHUNK)),
          ne(invoices.status, 'void'),
          eq(invoiceLines.kind, 'prev_adjustment'),
          isNotNull(invoiceLines.sessionId),
        ),
      );
    for (const r of rows) {
      const m = adjusted.get(r.studentId) ?? new Map<string, number>();
      m.set(r.sessionId!, (m.get(r.sessionId!) ?? 0) + r.amount);
      adjusted.set(r.studentId, m);
    }
  }

  const classIds = perSession.map((c) => c.id);
  const enrs = await t
    .select({
      classId: enrollments.classId,
      studentId: enrollments.studentId,
      joinedOn: enrollments.joinedOn,
      leftOn: enrollments.leftOn,
      feeOverride: enrollments.feeOverride,
    })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.tenantId, tenantId),
        inArray(enrollments.studentId, oldStudents),
        inArray(enrollments.classId, classIds),
      ),
    );
  const lastMonth = old.reduce(
    (m, o) => (o.periodMonth > m ? o.periodMonth : m),
    '',
  );
  const firstMonth = old.reduce(
    (m, o) => (o.periodMonth < m ? o.periodMonth : m),
    lastMonth,
  );
  const sessRows = await t
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
        between(sessions.sessionDate, firstMonth, monthEnd(lastMonth)),
      ),
    );
  const byClass = new Map<string, ClassSession[]>();
  const dateOf = new Map<string, string>();
  for (const s of sessRows) {
    dateOf.set(s.id, s.date);
    const l = byClass.get(s.classId) ?? [];
    l.push({ ...s, status: s.status as ClassSession['status'] });
    byClass.set(s.classId, l);
  }
  const att = new Map<string, Map<string, string>>();
  const sessIds = sessRows.map((s) => s.id);
  for (let i = 0; i < sessIds.length; i += CHUNK) {
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
          inArray(attendance.sessionId, sessIds.slice(i, i + CHUNK)),
          inArray(attendance.studentId, oldStudents),
        ),
      );
    for (const r of rows) {
      const m = att.get(r.studentId) ?? new Map<string, string>();
      m.set(r.sessionId, r.status);
      att.set(r.studentId, m);
    }
  }

  for (const o of old) {
    const recalc: RecalculatedSession[] = [];
    for (const e of enrs.filter((x) => x.studentId === o.studentId)) {
      const c = classById.get(e.classId)!;
      const fee: ClassFee = {
        className: c.name,
        feeType: c.feeType as FeeType,
        feeAmount: c.feeAmount!,
        feeRules: c.feeRules,
      };
      const r = computeEnrollmentInvoice(
        fee,
        e,
        { periodMonth: o.periodMonth, periodEnd: monthEnd(o.periodMonth) },
        byClass.get(e.classId) ?? [],
        att.get(o.studentId) ?? new Map(),
      );
      for (const l of r?.result.lines ?? [])
        if (l.kind === 'session' && l.sessionId)
          recalc.push({
            sessionId: l.sessionId,
            date: dateOf.get(l.sessionId) ?? '',
            className: c.name,
            amount: l.amount,
          });
    }
    const diffs = diffSessionCharges(
      issued.get(o.id) ?? new Map(),
      recalc,
      adjusted.get(o.studentId) ?? new Map(),
    );
    if (diffs.length)
      out.set(o.studentId, [...(out.get(o.studentId) ?? []), ...diffs]);
  }
  return out;
}
