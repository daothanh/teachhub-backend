// Hàm thuần cho thu tiền (S6-BE-02, US-7.4, DoD Mục 6.5). Không phụ thuộc Nest/Drizzle. Tiền là số nguyên đồng.

/** Tên sự kiện outbox khi ghi một thanh toán. */
export const PAYMENT_RECORDED = 'payment_recorded';

/** Payload outbox `payment_recorded`: không tên học viên (consumer tự tra tên). */
export interface PaymentRecordedPayload {
  invoiceId: string;
  paymentId: string;
  studentId: string;
  amount: number;
  paidOn: string;
  status: 'partially_paid' | 'paid';
  remainingAmount: number;
}

/** Trạng thái hóa đơn còn nhận thanh toán (US-7.4); `draft`, `void` và đã `paid` thì không. */
export const isPayable = (status: string): boolean =>
  status === 'issued' ||
  status === 'partially_paid' ||
  status === 'pending_confirmation';

/** Trạng thái hóa đơn suy từ Σ thanh toán còn hiệu lực. */
export const statusAfter = (
  total: number,
  paid: number,
): 'issued' | 'partially_paid' | 'paid' =>
  paid <= 0 ? 'issued' : paid >= total ? 'paid' : 'partially_paid';

/** Phần trả thừa (vào sổ học viên, US-7.6 AC2). */
export const overpaidOf = (total: number, paid: number): number =>
  Math.max(0, paid - total);

export const remainingOf = (total: number, paid: number): number =>
  Math.max(0, total - paid);

/**
 * Thay đổi của sổ học viên khi Σ thanh toán đổi từ `before` sang `after`: > 0 ghi có (`overpayment`), < 0 ghi nợ
 * (`payment_void`, đảo phần trả thừa đã ghi), 0 không ghi. Σ(credit − debit) của hóa đơn luôn bằng `overpaidOf`.
 */
export const overpaymentDelta = (
  total: number,
  before: number,
  after: number,
): number => overpaidOf(total, after) - overpaidOf(total, before);
