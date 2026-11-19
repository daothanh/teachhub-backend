/** Sự kiện outbox khi giáo viên dời, hủy hoặc tạo buổi bù (US-2.2). Chỉ chứa id và giờ, không có tên học viên. */
export const SCHEDULE_CHANGED = 'schedule_changed';

export interface ScheduleChangedPayload {
  change: 'rescheduled' | 'cancelled' | 'makeup';
  sessionId: string;
  classId: string;
  /** Giờ bắt đầu trước khi đổi (ISO UTC); null với buổi bù mới. */
  previousStartsAt: string | null;
  /** Giờ bắt đầu hiện tại (ISO UTC). */
  startsAt: string;
  reason: string | null;
  /** Buổi gốc đã hủy, chỉ có khi `change = makeup`. */
  makeupOf: string | null;
}
