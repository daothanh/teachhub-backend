// Báo vắng trước của phụ huynh (US-3.4), thuần: không NestJS/Drizzle. Luật thời gian (buổi chưa bắt đầu, không hủy, hủy trước giờ học)
// do hàm CSDL `create_absence_request`/`cancel_absence_request` quyết bằng đồng hồ DB, không lặp lại ở TS.
import type { AbsenceReason } from '@teachhub/modules/attendance';

/** Sự kiện outbox khi phụ huynh báo vắng: giáo viên của lớp nhận thông báo. Do hàm CSDL `create_absence_request` ghi. */
export const STUDENT_ABSENCE_REPORTED = 'student_absence_reported';

/** Payload tối thiểu: chỉ id, consumer tự đọc tên con, lớp, buổi, lý do từ `absence_requests` (không PII trong outbox). */
export interface AbsenceReportedPayload {
  absenceRequestId: string;
}

/** Yêu cầu tạo báo vắng (đã validate ở lớp http). `note` là văn bản thuần, tối đa 300 ký tự. */
export interface CreateAbsenceRequestInput {
  sessionId: string;
  studentId: string;
  reason: AbsenceReason;
  note?: string | undefined;
}

/** Báo vắng đang hiệu lực, giờ đã theo múi giờ tenant. */
export interface AbsenceRequestView {
  id: string;
  sessionId: string;
  studentId: string;
  classId: string;
  className: string;
  sessionStartsAt: string;
  reason: AbsenceReason;
  note: string | null;
  reportedAt: string;
}
