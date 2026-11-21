// Quy tắc gói Free/Pro (US-0.7, US-0.8). Hàm thuần: không NestJS/Drizzle.

export type SubscriptionStatus = 'free' | 'trialing' | 'active' | 'expired';
export type PlanCode = 'free' | 'pro';

export interface SubscriptionState {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * Trạng thái hiệu lực: `trialing`/`active` quá hạn tính là `expired` ngay, không đợi job `subscription.lifecycle`
 * (06:00) — nên hết hạn Pro thì giới hạn Free và 402 áp lại tức thì. Không có hạn (null) = còn hiệu lực.
 */
export function effectiveStatus(
  s: SubscriptionState,
  now: Date,
): SubscriptionStatus {
  if (
    (s.status === 'trialing' || s.status === 'active') &&
    s.currentPeriodEnd !== null &&
    s.currentPeriodEnd.getTime() <= now.getTime()
  )
    return 'expired';
  return s.status;
}

export const planCodeOf = (status: SubscriptionStatus): PlanCode =>
  status === 'trialing' || status === 'active' ? 'pro' : 'free';

/** Số ngày còn lại, làm tròn lên theo khối 24 giờ; không âm. shortcut: không theo ranh giới ngày của múi giờ tenant. */
export const daysLeft = (end: Date, now: Date): number =>
  Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));

/** Số bản ghi đang ở chế độ chỉ đọc vì vượt giới hạn (US-0.8 AC4); `limit` null = không giới hạn. */
export const overLimit = (active: number, limit: number | null): number =>
  limit === null ? 0 : Math.max(0, active - limit);

/** Tạo thêm `adding` bản ghi có vượt giới hạn không (US-0.7 AC1, AC2). */
export const exceedsLimit = (
  active: number,
  adding: number,
  limit: number | null,
): boolean => limit !== null && active + adding > limit;
