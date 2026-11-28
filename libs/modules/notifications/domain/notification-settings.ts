// Bật/tắt loại thông báo theo lớp (US-6.2): thuần, đọc JSON `classes.notification_settings` (khóa thiếu = bật).

/** Loại thông báo → khóa cài đặt của lớp. Loại không có trong bảng (tiền, thuê bao…) không phụ thuộc lớp. */
const TYPE_TO_KEY: Record<string, string> = {
  student_absent: 'absence',
  student_absent_correction: 'absence',
  schedule_changed: 'schedule',
  invoice_issued: 'invoice',
  payment_reminder: 'dunning',
};

export function isEnabled(settings: unknown, type: string): boolean {
  const key = TYPE_TO_KEY[type];
  if (!key) return true;
  return (settings as Record<string, unknown> | null)?.[key] !== false;
}

/** Nhiều lớp liên quan (hóa đơn gộp): chỉ bỏ khi mọi lớp đều tắt; không có lớp nào → gửi. */
export function isEnabledForAny(
  settingsList: unknown[],
  type: string,
): boolean {
  return (
    settingsList.length === 0 || settingsList.some((s) => isEnabled(s, type))
  );
}
