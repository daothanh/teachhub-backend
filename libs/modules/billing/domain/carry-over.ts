import { createHash } from 'node:crypto';

// Hàm thuần số dư chuyển kỳ (S6-BE-03, US-7.6, US-3.3 AC4). Không phụ thuộc Nest/Drizzle. Tiền là số nguyên đồng.
//
// Mô hình (Coordinator chốt): kết chuyển tại thời điểm PHÁT HÀNH. Bản nháp chỉ có dòng `carry_over` XEM TRƯỚC (tính lại khi đọc,
// khi `adjust` và khi phát hành). Phát hành (một giao dịch, khóa hóa đơn cũ): ghi sổ `unpaid_carried` + cộng `carried_amount` hóa đơn
// cũ, ghi `applied_to_invoice`. Σ dòng ngoài carry = 0 thì không phát hành; còn lại luôn chốt, tổng ≤ 0 thì hóa đơn 0 đ đã `paid`.

/**
 * Hóa đơn kỳ trước còn nợ được kết chuyển (xem trước nháp, job chốt kỳ, `issue` cùng đọc qua `loadCarryState`). Không gồm
 * `pending_confirmation` (US-7.7): phụ huynh đã báo chuyển, nợ chưa chắc còn. Kết chuyển lúc này thì khi giáo viên xác nhận, hóa
 * đơn cũ không thu được (409) và phụ huynh bị đòi lại ở kỳ sau. Bị từ chối thì hóa đơn về `issued`/`partially_paid` và lần phát
 * hành kế tiếp mới kết chuyển.
 */
export const CARRY_OPEN_STATUSES = ['issued', 'partially_paid'];

/**
 * `charges` = Σ dòng ngoài `carry_over` (phát sinh + điều chỉnh); `balance` = số dư chuyển kỳ (Σ còn nợ hóa đơn cũ + số dư sổ:
 * dương = nợ, âm = trả thừa). Tổng = max(0, charges + balance). `charges = 0` thì không phát hành (US-1.3 AC3, `issuable` false).
 * Ngược lại luôn chốt: `applied` = bút toán `applied_to_invoice` (> 0 ghi có, < 0 ghi nợ) đưa số dư sổ về `min(0, sum)`: tổng > 0
 * thì hấp thụ cả `balance`; tổng ≤ 0 (số dư đủ trả) thì ghi nợ đúng phần phát sinh được số dư trả (hoặc ghi có phần âm của điều
 * chỉnh tay), phần dư ở lại sổ để chuyển kỳ sau (US-7.6 AC4), hóa đơn `total = 0` và đã `paid`.
 */
export function planCarryOver(charges: number, balance: number) {
  const sum = charges + balance;
  return {
    /** Σ có dấu trước khi cắt về 0. */
    sum,
    /** Tổng lưu/hiển thị: nháp không có phát sinh (`charges = 0`) luôn 0 (không phát hành được, không bao giờ "còn tiền"). */
    total: charges === 0 ? 0 : Math.max(0, sum),
    /** Phần âm bị cắt (cùng công thức ở job, xem trước, `adjust`, `issue`). */
    clamped: charges === 0 ? 0 : Math.max(0, -sum),
    /** Dòng `carry_over` (có dấu); 0 = không có dòng. */
    carryOver: balance,
    issuable: charges !== 0,
    applied: balance - Math.min(0, sum),
  };
}

/** UUID ổn định (dạng v5) dẫn xuất từ `seed`, cho dòng xem trước không có hàng trong CSDL. */
export function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
