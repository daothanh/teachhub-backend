// Sự kiện outbox và hàm thuần cho "phụ huynh báo đã chuyển khoản" (S8-BE-claims, US-7.7). Không phụ thuộc Nest/Drizzle.

/** Phụ huynh vừa báo: giáo viên nhận thông báo. Do hàm CSDL `app_private.create_payment_claim` ghi cùng giao dịch. */
export const PAYMENT_CLAIM_CREATED = 'payment_claim_created';
/** Giáo viên bấm "Chưa nhận được": phụ huynh nhận thông báo. */
export const PAYMENT_CLAIM_REJECTED = 'payment_claim_rejected';

/** Payload cả hai sự kiện: chỉ id, không số tiền, tên hay lý do (consumer tự đọc từ `payment_claims`). */
export interface PaymentClaimEventPayload {
  claimId: string;
  invoiceId: string;
}
