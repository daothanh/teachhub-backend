export interface PushCopy {
  title: string;
  body: string;
  /** Kênh thông báo Android; app tạo sẵn đúng các id này. */
  channelId: 'attendance' | 'billing' | 'general';
}

/** Mọi loại thông báo có push; thêm loại mới mà thiếu mục ở `PUSH_COPY` thì không biên dịch được. */
export type PushType =
  | 'student_absent'
  | 'student_absent_correction'
  | 'invoice_issued'
  | 'payment_recorded'
  | 'billing_ready'
  | 'schedule_changed';

const OPEN = 'Mở DayHoc để xem.';

/**
 * Chữ hiện trên khay thông báo, CHUNG theo loại: không tên con, lớp hay số tiền (DoD 6.4, 6.7).
 * Chi tiết nằm trong hộp thông báo sau khi đăng nhập.
 */
export const PUSH_COPY: Record<PushType, PushCopy> = {
  student_absent: {
    title: 'Thông báo vắng học',
    body: `Con bạn được ghi vắng trong buổi học hôm nay. ${OPEN}`,
    channelId: 'attendance',
  },
  student_absent_correction: {
    title: 'Điều chỉnh điểm danh',
    body: `Điểm danh của con bạn vừa được điều chỉnh. ${OPEN}`,
    channelId: 'attendance',
  },
  invoice_issued: {
    title: 'Hóa đơn học phí mới',
    body: `Bạn có hóa đơn học phí mới. ${OPEN}`,
    channelId: 'billing',
  },
  payment_recorded: {
    title: 'Đã ghi nhận thanh toán',
    body: `Khoản thanh toán học phí của bạn đã được ghi nhận. ${OPEN}`,
    channelId: 'billing',
  },
  billing_ready: {
    title: 'Học phí đã sẵn sàng',
    body: `Bảng học phí kỳ này đã sẵn sàng để bạn xem lại. ${OPEN}`,
    channelId: 'billing',
  },
  schedule_changed: {
    title: 'Lịch học thay đổi',
    body: `Lịch học có thay đổi. ${OPEN}`,
    channelId: 'general',
  },
};

const DEFAULT_COPY: PushCopy = {
  title: 'DayHoc',
  body: `Bạn có thông báo mới. ${OPEN}`,
  channelId: 'general',
};

export const pushCopyFor = (type: string): PushCopy =>
  (PUSH_COPY as Record<string, PushCopy | undefined>)[type] ?? DEFAULT_COPY;
