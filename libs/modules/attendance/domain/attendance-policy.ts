// Luật điểm danh thuần (không NestJS/Drizzle): cửa sổ sửa, hiệu chỉnh lệch đồng hồ, LWW, tóm tắt.

export type AttendanceStatus = 'present' | 'late' | 'excused' | 'unexcused';

/** Buổi chỉ sửa được tới hết ngày thứ 7 kể từ ngày buổi học (theo múi giờ tenant). */
export const EDIT_WINDOW_DAYS = 7;
/** Lệch đồng hồ tối đa tin được; thiết bị lệch hơn thế (sai ngày giờ) bị kẹp, không kéo mốc LWW đi xa. */
export const MAX_CLOCK_SKEW_MS = 24 * 3_600_000;
/** Dòng "Có mặt" server tạo ngầm mang mốc thấp nhất để mọi mutation thật từ thiết bị đều thắng nó. */
export const IMPLICIT_UPDATED_AT = new Date(0);

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` cộng `n` ngày (lịch, không phụ thuộc múi giờ). */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** `today` là ngày hiện tại theo múi giờ tenant. Ngày thứ 7 vẫn còn sửa được. */
export function isWithinEditWindow(
  sessionDate: string,
  today: string,
): boolean {
  return today <= addDays(sessionDate, EDIT_WINDOW_DAYS);
}

/**
 * Lệch đồng hồ = giờ máy chủ − giờ thiết bị lúc gửi, kẹp ±24 giờ. Chỉ tính ở lần server nhận đầu tiên:
 * retry cùng `Idempotency-Key` trả lại phản hồi đã lưu, không bao giờ tính lại từ `deviceTime` của lần replay.
 */
export function clockSkewMs(serverNow: Date, deviceTime: Date): number {
  const skew = serverNow.getTime() - deviceTime.getTime();
  return Math.max(-MAX_CLOCK_SKEW_MS, Math.min(MAX_CLOCK_SKEW_MS, skew));
}

/**
 * Mốc LWW theo giờ máy chủ của một mutation: `clientUpdatedAt` + lệch đồng hồ. Mutation không thể xảy ra sau lúc
 * gửi (kẹp về `deviceTime`) hay sau lúc nhận (kẹp về `serverNow`).
 */
export function adjustedUpdatedAt(
  clientUpdatedAt: Date,
  deviceTime: Date,
  serverNow: Date,
): Date {
  const at = Math.min(clientUpdatedAt.getTime(), deviceTime.getTime());
  const adjusted = at + clockSkewMs(serverNow, deviceTime);
  return new Date(Math.min(adjusted, serverNow.getTime()));
}

/**
 * Mutation thắng khi mốc của nó LỚN HƠN mốc đang lưu. Bằng nhau → `stale`: app chỉ chính xác tới giây nên hai sửa
 * cùng giây là chấp nhận được, bản đang lưu giữ nguyên và client cập nhật theo `current`.
 */
export function winsLww(candidate: Date, stored: Date | null): boolean {
  return stored === null || candidate.getTime() > stored.getTime();
}

export function summarize(
  statuses: Iterable<AttendanceStatus>,
): Record<AttendanceStatus, number> {
  const s = { present: 0, late: 0, excused: 0, unexcused: 0 };
  for (const x of statuses) s[x]++;
  return s;
}

/** Vắng mới (tin khẩn cho phụ huynh): chuyển sang không phép từ trạng thái khác hoặc từ chưa có dòng. */
export function isNewAbsence(
  previous: AttendanceStatus | null,
  status: AttendanceStatus,
): boolean {
  return status === 'unexcused' && previous !== 'unexcused';
}

/** Đính chính: đang vắng không phép nay đi học (có mặt/đi muộn). Vắng có phép vẫn là vắng nên không đính chính. */
export function isAbsenceRetracted(
  previous: AttendanceStatus | null,
  status: AttendanceStatus,
): boolean {
  return (
    previous === 'unexcused' && (status === 'present' || status === 'late')
  );
}

export const ATTENDANCE_RECORDED = 'attendance_recorded';

/** Payload sự kiện outbox `attendance_recorded`: tối thiểu, không có ghi chú hay tên. */
export interface AttendanceRecordedPayload {
  sessionId: string;
  /** Giờ server lúc commit (ISO); mốc để tính "trong 10 phút" của đính chính. */
  recordedAt: string;
  changes: {
    studentId: string;
    attendanceId: string;
    status: AttendanceStatus;
    previousStatus: AttendanceStatus | null;
  }[];
}
