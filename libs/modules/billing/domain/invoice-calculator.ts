// Hàm thuần tính học phí (Technical Spec 4.7, US-7.1, US-7.6). Không phụ thuộc Nest/Drizzle/Redis.
// Tiền là số nguyên đồng (bigint trong CSDL map sang number). Ngày là chuỗi 'YYYY-MM-DD' (so sánh theo chữ).

export type FeeType = 'per_session' | 'monthly' | 'course';
export type AttendanceStatus = 'present' | 'excused' | 'unexcused';

export interface FeeRules {
  chargeExcused: boolean;
  chargeUnexcused: boolean;
  deductCancelled: boolean;
  /** Số đợt của trọn khóa. */
  installments: number;
}

/** Mặc định: tính cả hai loại vắng (US-7.1 AC1), không trừ buổi hủy, 1 đợt. */
export const DEFAULT_FEE_RULES: FeeRules = {
  chargeExcused: true,
  chargeUnexcused: true,
  deductCancelled: false,
  installments: 1,
};

export interface FeeOverride extends Partial<FeeRules> {
  /** Giá riêng của học sinh (đơn giá buổi / học phí tháng / giá khóa). */
  feeAmount?: number;
}

export interface SessionInput {
  id: string;
  date: string;
  /** Chỉ 'taught' và 'cancelled' vào tính toán; ngày lễ bị bỏ qua không có buổi nào (US-2.6 AC4). */
  status: 'taught' | 'cancelled';
  isMakeup: boolean;
  /** Buổi GV hủy đã được dạy bù. */
  madeUp?: boolean;
  /** null = chưa điểm danh. */
  attendance: AttendanceStatus | null;
}

export type Discount = { description: string } & (
  { kind: 'percent'; value: number } | { kind: 'amount'; value: number }
);

export interface InvoiceInput {
  feeType: FeeType;
  feeAmount: number;
  classRules?: Partial<FeeRules>;
  override?: FeeOverride;
  periodStart: string;
  periodEnd: string;
  joinedOn: string;
  leftOn?: string | null;
  sessions: SessionInput[];
  /** Theo tháng: số buổi theo lịch của kỳ. */
  plannedSessions?: number;
  /** Trọn khóa: tổng số buổi khóa và số buổi còn lại khi học viên vào. */
  totalSessions?: number;
  remainingSessions?: number;
  /** Trọn khóa: đợt (1-based) phát hành trong kỳ này. */
  installmentNo?: number;
  /** Số dư student_ledger: dương = nợ, âm = trả thừa. */
  carryOver?: number;
  /** Chênh lệch điểm danh sửa sau phát hành (có dấu). */
  prevAdjustments?: {
    sessionId: string;
    amount: number;
    description: string;
  }[];
  /** Miễn giảm định kỳ. */
  discounts?: Discount[];
  /** Phụ thu một lần. */
  surcharges?: { description: string; amount: number }[];
}

export type LineKind =
  | 'session'
  | 'monthly'
  | 'course_installment'
  | 'carry_over'
  | 'prev_adjustment'
  | 'discount'
  | 'surcharge';

export interface InvoiceLine {
  kind: LineKind;
  amount: number;
  sessionId?: string;
  description: string;
}

export interface InvoiceResult {
  lines: InvoiceLine[];
  /** = max(0, Σ lines). */
  total: number;
  /** Phần âm không hấp thụ được, tiếp tục chuyển kỳ (US-7.6 AC4). */
  creditCarriedForward: number;
}

function assertMoney(name: string, v: number, { signed = false } = {}): void {
  if (!Number.isSafeInteger(v) || (!signed && v < 0)) {
    throw new RangeError(
      `${name} phải là số nguyên đồng${signed ? '' : ' không âm'}: ${v}`,
    );
  }
}

/** round_1000(num/den): làm tròn tới 1.000 đ, từ 500 đ trở lên làm tròn lên. Thuần số nguyên. */
export function round1000Ratio(num: number, den: number): number {
  return Math.floor((num + 500 * den) / (1000 * den)) * 1000;
}

export function round1000(x: number): number {
  return round1000Ratio(x, 1);
}

/** Chia đợt: mỗi đợt round_1000(total/n); đợt cuối = tổng − Σ đợt trước (US-7.1 AC6). */
export function splitInstallments(total: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(`installments phải ≥ 1: ${n}`);
  const parts: number[] = [];
  let rest = total;
  for (let i = 0; i < n - 1; i++) {
    // shortcut: chặn đợt vượt phần còn lại để không có đợt âm; nâng cấp nếu cần quy tắc khác
    const part = Math.min(round1000Ratio(total, n), rest);
    parts.push(part);
    rest -= part;
  }
  parts.push(rest);
  return parts;
}

export function calculateInvoice(input: InvoiceInput): InvoiceResult {
  assertMoney('feeAmount', input.feeAmount);
  const o = input.override ?? {};
  const rules: FeeRules = {
    ...DEFAULT_FEE_RULES,
    ...input.classRules,
    ...stripUndefined(o),
  };
  const fee = o.feeAmount ?? input.feeAmount;
  assertMoney('fee', fee);

  const lines: InvoiceLine[] = [];
  const inRange = input.sessions.filter(
    (s) =>
      s.date >= input.periodStart &&
      s.date <= input.periodEnd &&
      s.date >= input.joinedOn &&
      (!input.leftOn || s.date < input.leftOn),
  );

  if (input.feeType === 'per_session') {
    for (const s of inRange) {
      const taught = s.status === 'taught' && !s.isMakeup;
      const charged =
        taught &&
        (s.attendance === 'excused'
          ? rules.chargeExcused
          : s.attendance === 'unexcused'
            ? rules.chargeUnexcused
            : true); // shortcut: chưa điểm danh coi như có mặt (tính tiền), Owner chốt
      lines.push({
        kind: 'session',
        amount: charged ? fee : 0,
        sessionId: s.id,
        description: charged ? `Buổi ${s.date}` : `Buổi ${s.date} (không tính)`,
      });
    }
  } else if (input.feeType === 'monthly') {
    let deduction = 0;
    if (rules.deductCancelled) {
      const planned = input.plannedSessions ?? 0;
      if (!Number.isInteger(planned) || planned < 1)
        throw new RangeError('plannedSessions phải ≥ 1');
      const cancelled = inRange.filter(
        (s) => s.status === 'cancelled' && !s.madeUp,
      ).length;
      // shortcut: trần khấu trừ = học phí tháng để không âm dòng gốc
      deduction = Math.min(fee, round1000Ratio(fee * cancelled, planned));
    }
    lines.push({
      kind: 'monthly',
      amount: fee - deduction,
      description: 'Học phí tháng',
    });
  } else {
    const total = input.totalSessions ?? 0;
    const remaining = input.remainingSessions ?? total;
    if (
      !Number.isInteger(total) ||
      total < 1 ||
      !Number.isInteger(remaining) ||
      remaining < 0 ||
      remaining > total
    ) {
      throw new RangeError(
        'totalSessions ≥ 1 và 0 ≤ remainingSessions ≤ totalSessions',
      );
    }
    const prorated = round1000Ratio(fee * remaining, total);
    const parts = splitInstallments(prorated, rules.installments);
    const no = input.installmentNo ?? 1;
    if (!Number.isInteger(no) || no < 1 || no > parts.length)
      throw new RangeError(`installmentNo ngoài 1..${parts.length}`);
    lines.push({
      kind: 'course_installment',
      amount: parts[no - 1]!,
      description: `Trọn khóa đợt ${no}/${parts.length}`,
    });
  }

  let room = lines.reduce((sum, l) => sum + l.amount, 0); // phần gốc còn có thể giảm
  const base = room;
  for (const d of input.discounts ?? []) {
    if (d.kind === 'percent' && (d.value < 0 || d.value > 100))
      throw new RangeError('percent 0..100');
    // miễn giảm 100% lấy đúng phần gốc (US-1.3 AC3); phần trăm khác làm tròn 1.000 đ
    const raw =
      d.kind === 'percent'
        ? d.value === 100
          ? base
          : round1000Ratio(base * d.value, 100)
        : d.value;
    assertMoney('discount', raw);
    const amount = Math.min(raw, room); // giảm không vượt phần gốc để hóa đơn không âm vì giảm giá
    room -= amount;
    lines.push({
      kind: 'discount',
      amount: -amount,
      description: d.description,
    });
  }
  if (input.carryOver) {
    assertMoney('carryOver', input.carryOver, { signed: true });
    lines.push({
      kind: 'carry_over',
      amount: input.carryOver,
      description: input.carryOver > 0 ? 'Nợ kỳ trước' : 'Trả thừa kỳ trước',
    });
  }
  for (const a of input.prevAdjustments ?? []) {
    assertMoney('prevAdjustment', a.amount, { signed: true });
    lines.push({
      kind: 'prev_adjustment',
      amount: a.amount,
      sessionId: a.sessionId,
      description: a.description,
    });
  }
  for (const s of input.surcharges ?? []) {
    assertMoney('surcharge', s.amount);
    lines.push({
      kind: 'surcharge',
      amount: s.amount,
      description: s.description,
    });
  }

  const sum = lines.reduce((acc, l) => acc + l.amount, 0);
  return {
    lines,
    total: Math.max(0, sum),
    creditCarriedForward: Math.max(0, -sum),
  };
}

function stripUndefined(o: FeeOverride): Partial<FeeRules> {
  const { feeAmount: _f, ...r } = o;
  return Object.fromEntries(
    Object.entries(r).filter(([, v]) => v !== undefined),
  );
}
