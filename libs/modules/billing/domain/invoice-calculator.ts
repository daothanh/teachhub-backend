// Hàm thuần tính học phí (Technical Spec 4.7, US-7.1, US-7.6). Không phụ thuộc Nest/Drizzle/Redis.
// Tiền là số nguyên đồng (bigint trong CSDL map sang number). Ngày là chuỗi 'YYYY-MM-DD' (so sánh theo chữ).

// Điểm chờ Owner chốt:
// 1) Kiểu theo buổi: buổi hủy rồi dạy bù đều 0 đ (buổi gốc hủy, buổi bù không tính).
// 2) Miễn giảm 100% chỉ đưa dòng gốc về 0; total vẫn có thể > 0 do carryOver/phụ thu.
// 3) Trọn khóa chia đợt: giảm giá áp ở mỗi đợt (tính trên phần gốc của đợt đó).
const MAX_INSTALLMENTS = 36;

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

/** Lý do một buổi được tính hoặc không tính tiền (dòng kind='session'). */
export type SessionReason =
  | 'taught'
  | 'excused_not_charged'
  | 'unexcused_not_charged'
  | 'cancelled'
  | 'makeup'
  | 'not_marked';

export interface InvoiceLine {
  kind: LineKind;
  amount: number;
  sessionId?: string;
  /** Chỉ có ở dòng buổi: buổi có tính tiền không và vì sao. */
  charged?: boolean;
  reason?: SessionReason;
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

/** round_1000(a × b / den) bằng BigInt, nên tích trung gian không tràn; ném RangeError nếu kết quả vượt safe integer. */
export function mulRound1000(a: number, b: number, den: number): number {
  assertMoney('a', a);
  assertMoney('b', b);
  if (!Number.isSafeInteger(den) || den < 1)
    throw new RangeError(`mẫu số phải ≥ 1: ${den}`);
  const d = BigInt(den);
  const r = ((BigInt(a) * BigInt(b) + 500n * d) / (1000n * d)) * 1000n;
  if (r > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('số tiền vượt giới hạn số nguyên an toàn');
  return Number(r);
}

/** Chỉ dành cho x ≥ 0 (tiền gốc); số âm ném RangeError. */
export function round1000(x: number): number {
  return mulRound1000(x, 1, 1);
}

/** Chia đợt: mỗi đợt round_1000(total/n); đợt cuối = tổng − Σ đợt trước (US-7.1 AC6). */
export function splitInstallments(total: number, n: number): number[] {
  assertMoney('total', total);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INSTALLMENTS)
    throw new RangeError(
      `installments phải là số nguyên 1..${MAX_INSTALLMENTS}: ${n}`,
    );
  const parts: number[] = [];
  let rest = total;
  for (let i = 0; i < n - 1; i++) {
    // shortcut: chặn đợt vượt phần còn lại để không có đợt âm; nâng cấp nếu cần quy tắc khác
    const part = Math.min(mulRound1000(total, 1, n), rest);
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
    ...stripNullish(input.classRules ?? {}),
    ...stripNullish(o),
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
      let reason: SessionReason = 'taught';
      if (s.status === 'cancelled') reason = 'cancelled';
      else if (s.isMakeup) reason = 'makeup';
      else if (s.attendance === 'excused' && !rules.chargeExcused)
        reason = 'excused_not_charged';
      else if (s.attendance === 'unexcused' && !rules.chargeUnexcused)
        reason = 'unexcused_not_charged';
      // chưa điểm danh coi như có mặt (tính tiền); shortcut: Owner chốt
      const charged = reason === 'taught';
      lines.push({
        kind: 'session',
        amount: charged ? fee : 0,
        sessionId: s.id,
        charged,
        reason,
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
      deduction = Math.min(fee, mulRound1000(fee, cancelled, planned));
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
    const prorated = mulRound1000(fee, remaining, total);
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
    if (
      d.kind === 'percent' &&
      !(Number.isInteger(d.value) && d.value >= 0 && d.value <= 100)
    )
      throw new RangeError('percent phải là số nguyên 0..100');
    // miễn giảm 100% lấy đúng phần gốc (US-1.3 AC3); phần trăm khác làm tròn 1.000 đ
    const raw =
      d.kind === 'percent'
        ? d.value === 100
          ? base
          : mulRound1000(base, d.value, 100)
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
  if (input.carryOver !== undefined) {
    assertMoney('carryOver', input.carryOver, { signed: true });
  }
  if (input.carryOver) {
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
  assertMoney('sum', sum, { signed: true });
  return {
    lines,
    total: Math.max(0, sum),
    creditCarriedForward: Math.max(0, -sum),
  };
}

function stripNullish(o: FeeOverride): Partial<FeeRules> {
  const { feeAmount: _f, ...r } = o;
  return Object.fromEntries(
    Object.entries(r).filter(([, v]) => v !== undefined && v !== null),
  );
}
