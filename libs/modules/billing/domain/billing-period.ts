// Hàm thuần dựng kỳ thu và đầu vào cho InvoiceCalculator (S5-BE-05, US-7.1, US-7.2). Không phụ thuộc Nest/Drizzle.
// Ngày là chuỗi 'YYYY-MM-DD' (so sánh theo chữ); tiền là số nguyên đồng.
//
// Quyết định nghiệp vụ (Owner chốt, vòng sửa sau review):
// D1 Kỳ M = tháng dương lịch M, chốt vào ngày `billingCloseDay` (1–28, mặc định 1) của tháng M+1: hóa đơn gồm mọi buổi
//    có ngày thuộc tháng M, kỳ liền kề không hở không chồng. Lỡ ngày chốt thì kỳ vẫn được tạo ở lần chạy sau (catch-up).
// D2 Hạn thanh toán = ngày chốt + `billingDueDays` (mặc định 10).
// D3 Buổi theo buổi còn `planned` lúc chốt (chưa điểm danh) không tính tiền nhưng vẫn có dòng 0 đ để giáo viên thấy.
// D4 Học viên `paused`: vẫn tính buổi theo buổi đã dạy, không thu học phí tháng/đợt trọn khóa; `left` hoặc ghi danh rời
//    lớp trước kỳ: không tính.
// D5 Học viên không có dòng nào: không có hóa đơn.
// D6 Số dư chuyển kỳ (S6-BE-03, US-7.6): KẾT CHUYỂN TẠI THỜI ĐIỂM PHÁT HÀNH qua sổ học viên (Coordinator chốt; giữ cách ghi thanh
//    toán theo hóa đơn, ít rủi ro sai tiền nhất). `billing.close` chỉ tạo bản nháp có dòng `carry_over` XEM TRƯỚC = Σ còn nợ các
//    hóa đơn kỳ trước đã phát hành (issued/partially_paid, không nháp/hủy) + số dư sổ (dương nợ, âm trả thừa): không ghi sổ, không
//    đụng hóa đơn cũ, nên hóa đơn cũ vẫn thu được cho tới khi hóa đơn mới được phát hành. Dòng xem trước được tính lại khi đọc
//    nháp (không ghi), khi `adjust` (ghi) và khi phát hành; tổng nháp = max(0, Σ dòng). `issue()` (một giao dịch) khóa hóa đơn cũ
//    còn nợ `ORDER BY id FOR UPDATE`, tính lại số dư dưới khóa, ghi `unpaid_carried` (nợ, gắn hóa đơn cũ) + `invoices.carried_amount`
//    của hóa đơn cũ, đặt dòng `carry_over` và tổng chốt, ghi `applied_to_invoice` (đối ứng, gắn hóa đơn mới) và
//    `oldest_due_date` = hạn cũ nhất của các hóa đơn nguồn (tuổi nợ T11 không bị "làm mới" khi chuyển kỳ). Σ dòng ngoài carry_over = 0 (vd.
//    miễn giảm 100%): không phát hành (ZERO_AMOUNT, US-1.3 AC3), không kết chuyển. Còn lại luôn chốt: tổng = max(0, Σ dòng ngoài
//    carry + số dư); tổng ≤ 0 (số dư đủ trả, hoặc điều chỉnh tay âm vượt phát sinh) thì hóa đơn có mã, `total = 0`, `paid`, không QR,
//    không `invoice_issued`; `applied_to_invoice` đưa số dư sổ về min(0, tổng): ghi nợ đúng phần phát sinh được số dư trả, hoặc ghi
//    có phần âm của điều chỉnh tay; phần dư ở lại sổ cho kỳ sau. Hệ quả: `remainingAmount` hóa đơn cũ = tổng − đã thu − carried_amount
//    nên công nợ chỉ tính ở hóa đơn mới (không đếm hai lần, nợ không chuyển lần hai); hóa đơn cũ thu được phần còn nợ, hết còn nợ
//    thì 409; không hủy được hóa đơn đã chuyển nợ hoặc mang dòng carry_over ≠ 0. Học viên không có dòng tiền kỳ đó (D5) không có
//    hóa đơn mới nên nợ vẫn ở hóa đơn cũ. Bất biến: Σ(dòng ngoài carry_over của hóa đơn đã phát hành chưa hủy) − Σ đã thu =
//    Σ remainingAmount + số dư sổ.
// D7 Điều chỉnh kỳ trước (US-3.3 AC4): điểm danh/buổi sửa sau khi hóa đơn kỳ cũ (12 tháng gần nhất, chưa hủy) đã phát hành → tính lại
//    bằng cùng calculator và so với dòng buổi đã phát hành; chênh lệch (buổi mới tính / bỏ tính / bị hủy / bị xóa) thành dòng
//    `prev_adjustment` ở bản nháp mới, trừ phần đã điều chỉnh ở các hóa đơn sau đã chốt (dòng trong nháp chưa chốt chưa tính; shortcut: hai nháp chưa chốt có thể cùng chứa một điều chỉnh); hóa đơn cũ không đổi. Chỉ lớp theo buổi. Giáo viên thấy
//    số tiền chênh ở dòng trong nháp. shortcut: chưa có thông báo riêng "đã điều chỉnh".
import {
  type AttendanceStatus,
  calculateInvoice,
  DEFAULT_FEE_RULES,
  type Discount,
  type FeeOverride,
  type FeeRules,
  type FeeType,
  type InvoiceResult,
  type SessionInput,
} from './invoice-calculator.js';

/** Hạn thanh toán mặc định: 10 ngày sau ngày chốt. */
export const DEFAULT_DUE_DAYS = 10;
const MAX_CLOSE_DAY = 28;
const MAX_DUE_DAYS = 90;

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return isoDay(Date.parse(`${date}T00:00:00Z`) + days * DAY);
}

/** Ngày 1 của tháng chứa `date`. */
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** Ngày cuối của tháng chứa `date`. */
export function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return isoDay(Date.UTC(y, m, 0));
}

/** Số tháng từ tháng của `from` đến tháng của `to` (0 = cùng tháng). */
export function monthsBetween(from: string, to: string): number {
  const f = from.split('-').map(Number) as [number, number];
  const t = to.split('-').map(Number) as [number, number];
  return (t[0] - f[0]) * 12 + (t[1] - f[1]);
}

export const DEFAULT_CLOSE_DAY = 1;

export interface BillingSettings {
  /** 1..28: ngày chốt của tháng liền sau kỳ. */
  closeDay: number;
  dueDays: number;
}

/**
 * Cấu hình ngày chốt và hạn thanh toán trong `tenants.settings` (`billingCloseDay`, `billingDueDays`).
 * Giá trị thiếu hoặc sai kiểu/ngoài khoảng thì dùng mặc định (ngày cuối tháng, 10 ngày).
 */
export function parseBillingSettings(settings: unknown): BillingSettings {
  const s = (
    settings && typeof settings === 'object' ? settings : {}
  ) as Record<string, unknown>;
  const day = s.billingCloseDay;
  const due = s.billingDueDays;
  return {
    closeDay:
      Number.isInteger(day) &&
      (day as number) >= 1 &&
      (day as number) <= MAX_CLOSE_DAY
        ? (day as number)
        : DEFAULT_CLOSE_DAY,
    dueDays:
      Number.isInteger(due) &&
      (due as number) >= 0 &&
      (due as number) <= MAX_DUE_DAYS
        ? (due as number)
        : DEFAULT_DUE_DAYS,
  };
}

export interface PeriodDates {
  /** Ngày 1 của tháng thu. */
  periodMonth: string;
  /** Ngày cuối của tháng thu. */
  periodEnd: string;
  closeDate: string;
  dueDate: string;
  /** Hôm nay đúng là ngày chốt (khác với lỡ ngày chốt, đang bù). */
  isCloseDay: boolean;
}

/**
 * Kỳ mới nhất đã tới ngày chốt tính đến `today`: tháng liền trước nếu hôm nay đã tới ngày chốt của tháng này, không thì
 * tháng trước nữa. Ngày chốt = `closeDay` của tháng liền sau kỳ.
 */
export function latestClosablePeriod(
  today: string,
  settings: BillingSettings,
): PeriodDates {
  const dd = String(settings.closeDay).padStart(2, '0');
  const closeThisMonth = `${today.slice(0, 7)}-${dd}`;
  const prevMonthEnd = addDays(monthStart(today), -1);
  const periodEnd =
    today >= closeThisMonth
      ? prevMonthEnd
      : addDays(monthStart(prevMonthEnd), -1);
  const closeDate =
    today >= closeThisMonth
      ? closeThisMonth
      : `${prevMonthEnd.slice(0, 7)}-${dd}`;
  return {
    periodMonth: monthStart(periodEnd),
    periodEnd,
    closeDate,
    dueDate: addDays(closeDate, settings.dueDays),
    isCloseDay: today === closeDate,
  };
}

// ---- Cấu hình học phí đọc từ jsonb ----

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const posInt = (v: unknown) =>
  Number.isInteger(v) && (v as number) >= 1 ? (v as number) : undefined;

/** `classes.fee_rules`: chỉ nhận đúng kiểu từng trường, trường khác bị bỏ. */
export function parseFeeRules(raw: unknown): Partial<FeeRules> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return stripUndefined({
    chargeExcused: bool(r.chargeExcused),
    chargeUnexcused: bool(r.chargeUnexcused),
    deductCancelled: bool(r.deductCancelled),
    installments: posInt(r.installments),
  });
}

/** `enrollments.fee_override` (dạng FeeOverride của classes.schemas) → FeeOverride + miễn giảm của calculator. */
export function parseFeeOverride(raw: unknown): {
  override: FeeOverride;
  discounts: Discount[];
} {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const discounts: Discount[] = [];
  if (Array.isArray(r.discounts)) {
    for (const d of r.discounts as Record<string, unknown>[]) {
      const description =
        typeof d?.description === 'string' ? d.description : '';
      if (d?.kind === 'percent' && posInt(d.percent))
        discounts.push({
          kind: 'percent',
          value: d.percent as number,
          description,
        });
      else if (d?.kind === 'amount' && posInt(d.amount))
        discounts.push({
          kind: 'amount',
          value: d.amount as number,
          description,
        });
    }
  }
  return {
    override: stripUndefined({
      feeAmount: posInt(r.feeAmount),
      ...parseFeeRules(r),
    }),
    discounts,
  };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Điểm danh của hệ thống có `late` (đi muộn vẫn có mặt) mà calculator không có. */
export function toCalcAttendance(
  status: string | undefined,
): AttendanceStatus | null {
  if (status === 'present' || status === 'late') return 'present';
  if (status === 'excused' || status === 'unexcused') return status;
  return null;
}

// ---- Tính hóa đơn của một ghi danh ----

export interface ClassFee {
  className: string;
  feeType: FeeType;
  feeAmount: number;
  feeRules: unknown;
}

export interface EnrollmentFee {
  studentId: string;
  joinedOn: string;
  leftOn: string | null;
  feeOverride: unknown;
}

/** Buổi của lớp (mọi ngày, mọi trạng thái); hàm tự lọc theo kỳ. */
export interface ClassSession {
  id: string;
  date: string;
  status: 'planned' | 'taught' | 'cancelled';
  isMakeup: boolean;
  makeupOf: string | null;
}

export interface EnrollmentInvoice {
  result: InvoiceResult;
  /** Chỉ có với lớp trọn khóa. */
  installmentNo?: number;
  installmentCount?: number;
}

/**
 * Tính phần hóa đơn của một ghi danh trong kỳ bằng `calculateInvoice`; null = ghi danh này không sinh dòng tiền
 * (trọn khóa đã hết đợt, hoặc lớp trọn khóa chưa có buổi nào để chia).
 * shortcut: trọn khóa lấy tổng buổi = số buổi chưa hủy hiện có của lớp (chưa có cột tổng buổi khóa); đợt n = kỳ thứ n
 * kể từ tháng học viên vào lớp. Nâng cấp khi có cấu hình tổng buổi của khóa.
 */
export function computeEnrollmentInvoice(
  cls: ClassFee,
  enr: EnrollmentFee,
  period: Pick<PeriodDates, 'periodMonth' | 'periodEnd'>,
  sessions: ClassSession[],
  attendance: ReadonlyMap<string, string>,
  opts: { paused?: boolean } = {},
): EnrollmentInvoice | null {
  // D4: học viên tạm nghỉ chỉ còn tiền theo buổi đã dạy; học phí tháng và đợt trọn khóa không thu.
  if (opts.paused && cls.feeType !== 'per_session') return null;
  const { override, discounts } = parseFeeOverride(enr.feeOverride);
  const classRules = parseFeeRules(cls.feeRules);
  const rules = {
    ...DEFAULT_FEE_RULES,
    ...classRules,
    ...stripUndefined(override),
  };
  const inPeriod = sessions.filter(
    (s) => s.date >= period.periodMonth && s.date <= period.periodEnd,
  );
  const madeUp = new Set(
    sessions.flatMap((s) =>
      s.isMakeup && s.status !== 'cancelled' && s.makeupOf ? [s.makeupOf] : [],
    ),
  );
  const calcSessions: SessionInput[] = inPeriod
    .filter((s) => s.status !== 'planned')
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      date: s.date,
      status: s.status as 'taught' | 'cancelled',
      isMakeup: s.isMakeup,
      madeUp: madeUp.has(s.id),
      attendance: toCalcAttendance(attendance.get(s.id)),
    }));

  const input = {
    feeType: cls.feeType,
    feeAmount: cls.feeAmount,
    classRules,
    override,
    periodStart: period.periodMonth,
    periodEnd: period.periodEnd,
    joinedOn: enr.joinedOn,
    leftOn: enr.leftOn,
    sessions: calcSessions,
    discounts,
  };

  if (cls.feeType === 'monthly') {
    const planned = inPeriod.filter((s) => !s.isMakeup).length;
    return {
      result: calculateInvoice({
        ...input,
        plannedSessions: Math.max(1, planned),
      }),
    };
  }
  if (cls.feeType === 'course') {
    const live = sessions.filter((s) => s.status !== 'cancelled');
    if (live.length < 1) return null;
    const installmentNo = monthsBetween(enr.joinedOn, period.periodMonth) + 1;
    if (installmentNo < 1 || installmentNo > rules.installments) return null;
    return {
      result: calculateInvoice({
        ...input,
        totalSessions: live.length,
        remainingSessions: live.filter((s) => s.date >= enr.joinedOn).length,
        installmentNo,
      }),
      installmentNo,
      installmentCount: rules.installments,
    };
  }
  const result = calculateInvoice(input);
  // D3: buổi còn `planned` lúc chốt (chưa điểm danh) không tính tiền nhưng vẫn hiện thành dòng 0 đ.
  // shortcut: DB và hợp đồng chưa có lý do không tính "chưa điểm danh" (CHECK chỉ nhận 4 lý do), nên dòng là
  // `charged = true` với 0 đ và chú thích trong `description`; đổi sang `charged = false` khi thêm lý do (cần migration + hợp đồng).
  const dateOf = new Map(inPeriod.map((s) => [s.id, s.date]));
  const unrecorded = inPeriod
    .filter(
      (s) =>
        s.status === 'planned' &&
        s.date >= enr.joinedOn &&
        (!enr.leftOn || s.date < enr.leftOn),
    )
    .map((s) => ({
      kind: 'session' as const,
      amount: 0,
      sessionId: s.id,
      charged: true,
      description: `Buổi ${s.date} (chưa điểm danh, không tính)`,
    }));
  if (!unrecorded.length) return { result };
  const date = (id?: string) => dateOf.get(id ?? '') ?? '';
  const sessionLines = [
    ...result.lines.filter((l) => l.kind === 'session'),
    ...unrecorded,
  ].sort((a, b) => date(a.sessionId).localeCompare(date(b.sessionId)));
  return {
    result: {
      ...result,
      lines: [
        ...sessionLines,
        ...result.lines.filter((l) => l.kind !== 'session'),
      ],
    },
  };
}
