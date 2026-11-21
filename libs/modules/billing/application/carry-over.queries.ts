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
import { uuidv7 } from '@teachhub/core';
import {
  attendance,
  classes,
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
  type IssuedSession,
  type PrevAdjustment,
  prevAdjustmentDescription,
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

/** Dòng hóa đơn không gắn buổi/lớp (mặc định), ghi đè bằng `more`. */
export const newLine = (
  tenantId: string,
  invoiceId: string,
  position: number,
  kind: string,
  description: string,
  amount: number,
  more: Partial<typeof invoiceLines.$inferInsert> = {},
): typeof invoiceLines.$inferInsert => ({
  id: uuidv7(),
  tenantId,
  invoiceId,
  position,
  kind,
  description,
  amount,
  charged: true,
  notChargedReason: null,
  sessionId: null,
  sessionDate: null,
  className: null,
  adjustmentReason: null,
  ...more,
});

const monthsBack = (monthStart: string, n: number): string => {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 10);
};

export interface OpenInvoice {
  id: string;
  periodMonth: string;
  /** total − paid − carried (> 0). */
  remaining: number;
  /** Hạn nợ của hóa đơn: `oldest_due_date` nếu đã nhận khoản chuyển kỳ, không thì hạn của kỳ. */
  dueDate: string;
}

export interface CarryState {
  /** Hóa đơn kỳ trước đã phát hành còn nợ (chưa chuyển). */
  open: OpenInvoice[];
  /** Số dư sổ học viên: Σ(debit − credit); dương = nợ, âm = trả thừa. */
  balance: number;
  /** Số dư chuyển kỳ = Σ còn nợ hóa đơn cũ + số dư sổ. */
  carry: number;
}

/**
 * Số dư chuyển kỳ của các học viên (hai truy vấn cho cả lô): hóa đơn đã phát hành chưa thu đủ của kỳ trước `periodMonth` và số
 * dư sổ. `lock` = khóa hóa đơn cũ `ORDER BY id FOR UPDATE` một lần cho cả lô (phát hành): ghi thanh toán song song cùng khóa nên
 * số còn nợ đọc ở đây là số đã commit và đứng yên tới hết giao dịch.
 */
export async function loadCarryState(
  t: Tx,
  tenantId: string,
  studentIds: string[],
  periodMonth: string,
  lock = false,
): Promise<Map<string, CarryState>> {
  const out = new Map<string, CarryState>(
    studentIds.map((id) => [id, { open: [], balance: 0, carry: 0 }]),
  );
  if (!studentIds.length) return out;
  const q = t
    .select({
      id: invoices.id,
      studentId: invoices.studentId,
      total: invoices.totalAmount,
      paid: invoices.paidAmount,
      carried: invoices.carriedAmount,
      oldest: invoices.oldestDueDate,
      periodMonth: billingPeriods.periodMonth,
      dueDate: billingPeriods.dueDate,
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
        inArray(invoices.studentId, studentIds),
        inArray(invoices.status, OPEN),
        lt(billingPeriods.periodMonth, periodMonth),
      ),
    )
    .orderBy(invoices.id);
  for (const r of await (lock ? q.for('update', { of: invoices }) : q)) {
    const remaining = Math.max(0, r.total - r.paid - r.carried);
    if (remaining > 0)
      out.get(r.studentId)!.open.push({
        id: r.id,
        periodMonth: r.periodMonth,
        remaining,
        dueDate: r.oldest ?? r.dueDate,
      });
  }
  const bal = await t
    .select({
      studentId: studentLedger.studentId,
      n: sql<string>`sum(${studentLedger.debit} - ${studentLedger.credit})::text`,
    })
    .from(studentLedger)
    .where(
      and(
        eq(studentLedger.tenantId, tenantId),
        inArray(studentLedger.studentId, studentIds),
      ),
    )
    .groupBy(studentLedger.studentId);
  for (const b of bal) out.get(b.studentId)!.balance = Number(b.n);
  for (const s of out.values())
    s.carry = s.balance + s.open.reduce((n, o) => n + o.remaining, 0);
  return out;
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
  const issued = new Map<string, Map<string, IssuedSession>>();
  for (let i = 0; i < old.length; i += CHUNK) {
    const rows = await t
      .select({
        invoiceId: invoiceLines.invoiceId,
        sessionId: invoiceLines.sessionId,
        amount: invoiceLines.amount,
        date: invoiceLines.sessionDate,
        className: invoiceLines.className,
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
      const m = issued.get(r.invoiceId) ?? new Map<string, IssuedSession>();
      m.set(r.sessionId!, {
        amount: (m.get(r.sessionId!)?.amount ?? 0) + r.amount,
        date: r.date ?? '',
        className: r.className ?? '',
      });
      issued.set(r.invoiceId, m);
    }
  }

  // Phần đã điều chỉnh ở các hóa đơn sau đã chốt (không tính nháp, hóa đơn hủy), theo học viên.
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
          // Chỉ hóa đơn đã chốt mới tính là "đã điều chỉnh": dòng trong nháp chưa phát hành/bỏ qua chưa có hiệu lực.
          inArray(invoices.status, ISSUED),
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

  // Buổi đã tính tiền ở hóa đơn cũ mà nay không còn (xóa hẳn) → điều chỉnh âm.
  const issuedIds = [
    ...new Set([...issued.values()].flatMap((m) => [...m.keys()])),
  ];
  const existing = new Set<string>();
  for (let i = 0; i < issuedIds.length; i += CHUNK)
    for (const r of await t
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          inArray(sessions.id, issuedIds.slice(i, i + CHUNK)),
        ),
      ))
      existing.add(r.id);
  const gone = new Set(issuedIds.filter((id) => !existing.has(id)));
  const enrsByStudent = new Map<string, typeof enrs>();
  for (const e of enrs)
    enrsByStudent.set(e.studentId, [
      ...(enrsByStudent.get(e.studentId) ?? []),
      e,
    ]);

  for (const o of old) {
    const recalc: RecalculatedSession[] = [];
    for (const e of enrsByStudent.get(o.studentId) ?? []) {
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
      gone,
    );
    if (diffs.length)
      out.set(o.studentId, [...(out.get(o.studentId) ?? []), ...diffs]);
  }
  return out;
}

/** Σ các dòng KHÔNG phải `carry_over` của từng hóa đơn (phần phát sinh + điều chỉnh, không phụ thuộc xem trước chuyển kỳ). */
export async function nonCarrySums(
  t: Tx,
  tenantId: string,
  invoiceIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>(invoiceIds.map((id) => [id, 0]));
  for (let i = 0; i < invoiceIds.length; i += CHUNK)
    for (const r of await t
      .select({
        id: invoiceLines.invoiceId,
        n: sql<string>`sum(${invoiceLines.amount})::text`,
      })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.tenantId, tenantId),
          inArray(invoiceLines.invoiceId, invoiceIds.slice(i, i + CHUNK)),
          ne(invoiceLines.kind, 'carry_over'),
        ),
      )
      .groupBy(invoiceLines.invoiceId))
      out.set(r.id, Number(r.n));
  return out;
}

/** Thay dòng `carry_over` của BẢN NHÁP bằng số xem trước `carry` (0 = bỏ dòng). Gọi khi đã khóa hóa đơn. */
export async function setCarryLine(
  t: Tx,
  tenantId: string,
  invoiceId: string,
  carry: number,
): Promise<void> {
  const where = and(
    eq(invoiceLines.tenantId, tenantId),
    eq(invoiceLines.invoiceId, invoiceId),
  );
  await t
    .delete(invoiceLines)
    .where(and(where, eq(invoiceLines.kind, 'carry_over')));
  if (!carry) return;
  const [m] = await t
    .select({
      max: sql<number>`coalesce(max(${invoiceLines.position}), 0)::int`,
    })
    .from(invoiceLines)
    .where(where);
  await t
    .insert(invoiceLines)
    .values(
      newLine(
        tenantId,
        invoiceId,
        (m?.max ?? 0) + 1,
        'carry_over',
        carry > 0 ? 'Nợ kỳ trước' : 'Trả thừa kỳ trước',
        carry,
      ),
    );
}

/** `loadPrevAdjustments` với danh sách lớp tự đọc (cho `issue`, `adjust`, xem trước nháp). */
export async function loadPrevAdjustmentsFor(
  t: Tx,
  tenantId: string,
  periodMonth: string,
  studentIds: string[],
): Promise<Map<string, PrevAdjustment[]>> {
  if (!studentIds.length) return new Map();
  const rows = await t
    .select()
    .from(classes)
    .where(and(eq(classes.tenantId, tenantId), isNotNull(classes.feeType)));
  return loadPrevAdjustments(
    t,
    tenantId,
    periodMonth,
    studentIds,
    new Map(rows.map((c) => [c.id, c])),
  );
}

/** Σ các dòng KHÔNG phải `carry_over` và KHÔNG phải `prev_adjustment` (phát sinh + điều chỉnh tay) của từng hóa đơn. */
export async function baseSums(
  t: Tx,
  tenantId: string,
  invoiceIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>(invoiceIds.map((id) => [id, 0]));
  for (let i = 0; i < invoiceIds.length; i += CHUNK)
    for (const r of await t
      .select({
        id: invoiceLines.invoiceId,
        n: sql<string>`sum(${invoiceLines.amount})::text`,
      })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.tenantId, tenantId),
          inArray(invoiceLines.invoiceId, invoiceIds.slice(i, i + CHUNK)),
          sql`${invoiceLines.kind} not in ('carry_over', 'prev_adjustment')`,
        ),
      )
      .groupBy(invoiceLines.invoiceId))
      out.set(r.id, Number(r.n));
  return out;
}

export interface DraftPreview {
  /** Điều chỉnh kỳ trước tính lại theo số liệu hiện tại (đã loại phần có ở hóa đơn đã chốt). */
  adjustments: PrevAdjustment[];
  /** Σ dòng ngoài carry_over: phát sinh + điều chỉnh tay + điều chỉnh kỳ trước (tính lại). */
  charges: number;
  /** Số dư chuyển kỳ xem trước. */
  carry: number;
}

/** Xem trước của các bản nháp (không ghi): điều chỉnh kỳ trước và số dư chuyển kỳ tính lại từ số liệu hiện tại. */
export async function previewDrafts(
  t: Tx,
  tenantId: string,
  drafts: { id: string; studentId: string }[],
  periodMonth: string,
  lock = false,
): Promise<{
  previews: Map<string, DraftPreview>;
  states: Map<string, CarryState>;
}> {
  const studentIds = [...new Set(drafts.map((d) => d.studentId))];
  const states = await loadCarryState(
    t,
    tenantId,
    studentIds,
    periodMonth,
    lock,
  );
  const adj = await loadPrevAdjustmentsFor(
    t,
    tenantId,
    periodMonth,
    studentIds,
  );
  const base = await baseSums(
    t,
    tenantId,
    drafts.map((d) => d.id),
  );
  return {
    states,
    previews: new Map(
      drafts.map((d) => {
        const adjustments = adj.get(d.studentId) ?? [];
        return [
          d.id,
          {
            adjustments,
            charges:
              base.get(d.id)! + adjustments.reduce((n, a) => n + a.amount, 0),
            carry: states.get(d.studentId)!.carry,
          },
        ] as const;
      }),
    ),
  };
}

/** Thay các dòng `prev_adjustment` của BẢN NHÁP bằng `adjustments` (nối vào cuối). Gọi khi đã khóa hóa đơn. */
export async function setPrevAdjustmentLines(
  t: Tx,
  tenantId: string,
  invoiceId: string,
  adjustments: PrevAdjustment[],
): Promise<void> {
  const where = and(
    eq(invoiceLines.tenantId, tenantId),
    eq(invoiceLines.invoiceId, invoiceId),
  );
  await t
    .delete(invoiceLines)
    .where(and(where, eq(invoiceLines.kind, 'prev_adjustment')));
  if (!adjustments.length) return;
  const [m] = await t
    .select({
      max: sql<number>`coalesce(max(${invoiceLines.position}), 0)::int`,
    })
    .from(invoiceLines)
    .where(where);
  await t.insert(invoiceLines).values(
    adjustments.map((a, i) =>
      newLine(
        tenantId,
        invoiceId,
        (m?.max ?? 0) + 1 + i,
        'prev_adjustment',
        prevAdjustmentDescription(a),
        a.amount,
        {
          sessionId: a.sessionId,
          sessionDate: a.date || null,
          className: a.className,
        },
      ),
    ),
  );
}
