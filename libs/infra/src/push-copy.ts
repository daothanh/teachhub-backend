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
  | 'student_absence_reported'
  | 'invoice_issued'
  | 'payment_recorded'
  | 'payment_reminder'
  | 'billing_ready'
  | 'payment_claim_created'
  | 'payment_claim_rejected'
  | 'subscription_expiring'
  | 'subscription_activated'
  | 'tax_threshold_alert'
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
  student_absence_reported: {
    title: 'Phụ huynh báo vắng trước',
    body: `Có phụ huynh vừa báo học viên nghỉ một buổi sắp tới. ${OPEN}`,
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
  payment_reminder: {
    title: 'DayHoc nhắc học phí',
    body: `DayHoc nhắc: bạn có khoản học phí cần thanh toán. ${OPEN}`,
    channelId: 'billing',
  },
  billing_ready: {
    title: 'Học phí đã sẵn sàng',
    body: `Bảng học phí kỳ này đã sẵn sàng để bạn xem lại. ${OPEN}`,
    channelId: 'billing',
  },
  payment_claim_created: {
    title: 'Phụ huynh báo đã chuyển khoản',
    body: `Có phụ huynh vừa báo đã chuyển khoản học phí, cần bạn xác nhận. ${OPEN}`,
    channelId: 'billing',
  },
  payment_claim_rejected: {
    title: 'Chưa nhận được học phí',
    body: `Giáo viên chưa nhận được khoản chuyển khoản bạn đã báo. ${OPEN}`,
    channelId: 'billing',
  },
  subscription_expiring: {
    title: 'Gói Pro sắp hết hạn',
    body: `Gói Pro của bạn sắp hết hạn, hãy gia hạn để dùng liền mạch. ${OPEN}`,
    channelId: 'general',
  },
  subscription_activated: {
    title: 'Gói Pro đã kích hoạt',
    body: `Gói Pro của bạn đã được kích hoạt. ${OPEN}`,
    channelId: 'general',
  },
  tax_threshold_alert: {
    title: 'Nhắc theo dõi doanh thu năm',
    body: `Doanh thu năm của bạn đã tới mốc cần theo dõi. ${OPEN}`,
    channelId: 'general',
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
