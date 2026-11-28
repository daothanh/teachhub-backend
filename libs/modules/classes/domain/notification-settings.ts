// Bật/tắt loại thông báo theo lớp (US-6.2). Thuần: không import NestJS/Drizzle.

export const NOTIFICATION_SETTING_KEYS = [
  'absence',
  'grade',
  'homework',
  'invoice',
  'dunning',
  'schedule',
] as const;
export type NotificationSettingKey = (typeof NOTIFICATION_SETTING_KEYS)[number];
export type NotificationSettings = Record<NotificationSettingKey, boolean>;

/** Thiếu khóa (dữ liệu cũ, PATCH một phần) coi như bật: lớp mới nhận đủ 6 loại. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  absence: true,
  grade: true,
  homework: true,
  invoice: true,
  dunning: true,
  schedule: true,
};

/** Gộp theo khóa: `patch` đè `stored`, khóa thiếu ở cả hai lấy mặc định (bật). */
export function mergeNotificationSettings(
  stored: unknown,
  patch: Partial<NotificationSettings> = {},
): NotificationSettings {
  const base =
    stored && typeof stored === 'object'
      ? (stored as Partial<NotificationSettings>)
      : {};
  const out = { ...DEFAULT_NOTIFICATION_SETTINGS };
  for (const k of NOTIFICATION_SETTING_KEYS) {
    const v = patch[k] ?? base[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
