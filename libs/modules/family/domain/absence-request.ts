// Luật báo vắng trước của phụ huynh (US-3.4), thuần: không NestJS/Drizzle.

/** Sự kiện outbox khi phụ huynh báo vắng mới: giáo viên của lớp nhận thông báo. Do hàm CSDL `create_absence_request` ghi. */
export const STUDENT_ABSENCE_REPORTED = 'student_absence_reported';

/** Payload tối thiểu: chỉ id, consumer tự đọc tên con, lớp, buổi, lý do từ `absence_requests` (không PII trong outbox). */
export interface AbsenceReportedPayload {
  absenceRequestId: string;
}

export type ReportGate = 'ok' | 'cancelled' | 'started';

/**
 * Chỉ báo vắng cho buổi CHƯA bắt đầu (`startsAt` > bây giờ, đúng giờ bắt đầu thì đã bắt đầu) và không hủy (US-3.4 AC2).
 * Buổi hủy xét trước: không báo vắng được kể cả khi giờ chưa tới.
 */
export function checkReportable(
  session: { status: string; startsAt: Date },
  now: Date,
): ReportGate {
  if (session.status === 'cancelled') return 'cancelled';
  return session.startsAt.getTime() > now.getTime() ? 'ok' : 'started';
}

/** Hủy báo vắng chỉ trước giờ bắt đầu buổi (US-3.4 AC3). */
export function canCancelAbsence(startsAt: Date, now: Date): boolean {
  return startsAt.getTime() > now.getTime();
}
