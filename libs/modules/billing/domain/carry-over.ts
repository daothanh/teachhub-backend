// Hàm thuần số dư chuyển kỳ (S6-BE-03, US-7.6, US-3.3 AC4). Không phụ thuộc Nest/Drizzle. Tiền là số nguyên đồng.
//
// Mô hình (Coordinator chốt): kết chuyển tại thời điểm PHÁT HÀNH. Bản nháp chỉ có dòng `carry_over` XEM TRƯỚC (tính lại khi đọc,
// khi `adjust` và khi phát hành). Phát hành (một giao dịch, khóa hóa đơn cũ): ghi sổ `unpaid_carried` + cộng `carried_amount` hóa đơn
// cũ, ghi `applied_to_invoice` cho phần hóa đơn hấp thụ. Tổng ≤ 0 thì không phát hành, không kết chuyển gì.

/**
 * `charges` = Σ dòng ngoài `carry_over` (phát sinh + điều chỉnh); `balance` = số dư chuyển kỳ (Σ còn nợ hóa đơn cũ + số dư sổ:
 * dương = nợ, âm = trả thừa). Tổng = max(0, charges + balance). Chỉ khi tổng > 0 mới phát hành và kết chuyển (`applied` =
 * `balance`: bút toán `applied_to_invoice`, > 0 ghi có, < 0 ghi nợ); tổng ≤ 0 thì không phát hành, không kết chuyển gì (US-7.6 AC4:
 * nợ/dư giữ nguyên chỗ cũ).
 */
export function planCarryOver(charges: number, balance: number) {
  const sum = charges + balance;
  return {
    /** Σ có dấu trước khi cắt về 0. */
    sum,
    total: Math.max(0, sum),
    /** Dòng `carry_over` (có dấu); 0 = không có dòng. */
    carryOver: balance,
    issuable: sum > 0,
    applied: sum > 0 ? balance : 0,
  };
}

export interface IssuedSession {
  amount: number;
  date: string;
  className: string;
}

export interface RecalculatedSession {
  sessionId: string;
  date: string;
  className: string;
  /** Tiền buổi tính lại bằng calculator theo điểm danh hiện tại. */
  amount: number;
}

export interface PrevAdjustment {
  sessionId: string;
  date: string;
  className: string;
  amount: number;
}

/**
 * Chênh lệch các buổi của một hóa đơn đã phát hành so với dữ liệu hiện tại (US-3.3 AC4). So theo việc buổi CÓ TÍNH TIỀN hay
 * không (đổi đơn giá lớp sau phát hành không sinh chênh lệch): mới tính, trước không → +tiền tính lại; trước tính, nay không
 * (hủy, vắng không tính) → −tiền đã phát hành; buổi đã bị xóa hẳn (`gone`) mà trước đã tính → −tiền đã phát hành. Trừ phần đã
 * điều chỉnh ở các hóa đơn sau (`adjusted`): chạy lại không điều chỉnh hai lần, sửa về như cũ thì điều chỉnh ngược lại.
 * shortcut: chưa áp miễn giảm phần trăm của kỳ cũ vào chênh lệch; làm khi có yêu cầu.
 */
export function diffSessionCharges(
  issued: ReadonlyMap<string, IssuedSession>,
  recalculated: readonly RecalculatedSession[],
  adjusted: ReadonlyMap<string, number>,
  gone: ReadonlySet<string> = new Set(),
): PrevAdjustment[] {
  const out: PrevAdjustment[] = [];
  const push = (a: PrevAdjustment, delta: number) => {
    const amount = delta - (adjusted.get(a.sessionId) ?? 0);
    if (amount !== 0) out.push({ ...a, amount });
  };
  for (const r of recalculated) {
    const before = issued.get(r.sessionId)?.amount ?? 0;
    const delta =
      r.amount > 0 && before <= 0
        ? r.amount
        : r.amount <= 0 && before > 0
          ? -before
          : 0;
    push(
      {
        sessionId: r.sessionId,
        date: r.date,
        className: r.className,
        amount: 0,
      },
      delta,
    );
  }
  for (const [sessionId, s] of issued)
    if (gone.has(sessionId) && s.amount > 0)
      push(
        { sessionId, date: s.date, className: s.className, amount: 0 },
        -s.amount,
      );
  return out;
}

/** `1200000` → `1.200.000`. */
export const formatVnd = (n: number): string =>
  Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Mô tả dòng `prev_adjustment`: ghi rõ buổi và số tiền chênh (US-7.6 AC3). */
export const prevAdjustmentDescription = (a: PrevAdjustment): string =>
  `Điều chỉnh kỳ trước: buổi ${a.date} (${a.className}) ${a.amount > 0 ? 'tính thêm' : 'bỏ tính'} ${formatVnd(a.amount)} đ`;
