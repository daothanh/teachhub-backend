// Vòng đời gói (US-0.8 AC5): mốc nhắc gia hạn. Hàm thuần, không NestJS/Drizzle.

/** Tên sự kiện outbox khi job `subscription.lifecycle` nhắc gia hạn. */
export const SUBSCRIPTION_EXPIRING = 'subscription_expiring';
/** Tên sự kiện outbox khi quản trị xác nhận chuyển khoản và Pro được kích hoạt (US-0.8 AC3). */
export const SUBSCRIPTION_ACTIVATED = 'subscription_activated';

export type ReminderOffset = 7 | 1;

/** Payload outbox `subscription_expiring`: không PII, chỉ mốc và hạn để consumer kiểm lại kỳ còn hiệu lực. */
export interface SubscriptionExpiringPayload {
  offsetDays: ReminderOffset;
  currentPeriodEnd: string;
}

/**
 * Mốc nhắc ứng với số ngày còn lại (đã làm tròn lên, xem `daysLeft`): còn ≤ 1 ngày → mốc 1, còn ≤ 7 ngày → mốc 7, còn lại không nhắc.
 * Chỉ trả MỘT mốc (mốc sát nhất) nên job chạy muộn hay bỏ lỡ một ngày không dồn hai lời nhắc cùng lúc.
 */
export function reminderOffset(daysLeft: number): ReminderOffset | null {
  if (daysLeft < 1) return null;
  if (daysLeft <= 1) return 1;
  return daysLeft <= 7 ? 7 : null;
}
