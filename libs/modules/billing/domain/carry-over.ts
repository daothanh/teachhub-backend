// Hàm thuần số dư chuyển kỳ (S6-BE-03, US-7.6, US-3.3 AC4). Không phụ thuộc Nest/Drizzle. Tiền là số nguyên đồng.
//
// Mô hình (Owner giao chọn; chọn "kết chuyển hẳn qua sổ học viên"): nợ còn lại của hóa đơn kỳ trước được ghi sổ
// `unpaid_carried` (nợ) rồi đưa vào dòng `carry_over` của bản nháp kỳ mới; hóa đơn cũ đánh dấu `carried_amount`
// nên `remainingAmount` của nó giảm tương ứng và công nợ chỉ còn nằm ở hóa đơn mới.

/** Số dư sổ học viên: dương = nợ, âm = trả thừa. `charges` = phát sinh kỳ này (Σ ghi danh đã cắt ≥ 0) + Σ điều chỉnh kỳ trước. */
export function planCarryOver(charges: number, balance: number) {
  const sum = charges + balance;
  // Phần âm không hấp thụ được ở lại sổ để chuyển kỳ sau (US-7.6 AC4).
  const balanceAfter = Math.min(0, sum);
  return {
    /** Tổng hóa đơn = max(0, charges + balance). */
    total: Math.max(0, sum),
    /** Dòng `carry_over` (có dấu); 0 = không có dòng. */
    carryOver: balance,
    /** Số dư sổ sau khi hóa đơn hấp thụ: bút toán `applied_to_invoice` = balance − balanceAfter (> 0 ghi có, < 0 ghi nợ). */
    applied: balance - balanceAfter,
  };
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
 * Chênh lệch các buổi của một hóa đơn đã phát hành so với điểm danh hiện tại (US-3.3 AC4). So theo việc buổi CÓ TÍNH TIỀN hay
 * không (đổi đơn giá lớp sau phát hành không sinh chênh lệch): mới tính, trước không → +tiền tính lại; trước tính, nay không →
 * −tiền đã phát hành. Trừ phần đã điều chỉnh ở các hóa đơn sau (`adjusted`), nên chạy lại không điều chỉnh hai lần và sửa về
 * như cũ thì điều chỉnh ngược lại.
 * shortcut: chưa áp miễn giảm phần trăm của kỳ cũ vào chênh lệch; làm khi có yêu cầu.
 */
export function diffSessionCharges(
  issued: ReadonlyMap<string, number>,
  recalculated: readonly RecalculatedSession[],
  adjusted: ReadonlyMap<string, number>,
): PrevAdjustment[] {
  const out: PrevAdjustment[] = [];
  for (const r of recalculated) {
    const before = issued.get(r.sessionId) ?? 0;
    const delta =
      r.amount > 0 && before <= 0
        ? r.amount
        : r.amount <= 0 && before > 0
          ? -before
          : 0;
    const amount = delta - (adjusted.get(r.sessionId) ?? 0);
    if (amount !== 0)
      out.push({
        sessionId: r.sessionId,
        date: r.date,
        className: r.className,
        amount,
      });
  }
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
