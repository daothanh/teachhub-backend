// Cấu hình học phí của lớp (US-1.2); thuần, không phụ thuộc NestJS/Drizzle.
// Import thẳng file domain thuần (không qua index) để spec đơn vị không kéo theo cấu hình Nest/env của module billing.
import {
  DEFAULT_FEE_RULES,
  type FeeRules,
  type FeeType,
} from '../../billing/domain/invoice-calculator.js';

export interface FeeDraft {
  feeType: FeeType | null;
  feeAmount: number | null;
  /** Quy tắc đã lưu hoặc vừa gửi (có thể thiếu trường); null = mặc định. */
  feeRules: Partial<FeeRules> | null;
  endDate: string | null;
  scheduleRuleCount: number;
}

/** Điền mặc định cho trường thiếu; không có học phí thì không có quy tắc. */
export function resolveFeeRules(
  feeType: FeeType | null,
  rules: Partial<FeeRules> | null | undefined,
): FeeRules | null {
  if (!feeType) return null;
  const merged = { ...DEFAULT_FEE_RULES, ...stripUndefined(rules ?? {}) };
  // Chỉ trọn khóa mới chia đợt: đổi kiểu mà giữ quy tắc cũ thì đưa về 1 đợt.
  return feeType === 'course' ? merged : { ...merged, installments: 1 };
}

const stripUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Lỗi theo trường trên bản đã gộp; rỗng = hợp lệ. */
export function classFeeErrors(c: FeeDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (c.feeType === null && c.feeAmount !== null) {
    errors.feeType = ['Vui lòng chọn kiểu học phí.'];
  }
  if (c.feeType !== null && c.feeAmount === null) {
    errors.feeAmount = ['Vui lòng nhập số tiền học phí.'];
  }
  if (c.feeType === null && c.feeRules !== null) {
    errors.feeRules = ['Chỉ đặt quy tắc khi lớp có học phí.'];
  }
  if (
    c.feeType !== null &&
    c.feeType !== 'course' &&
    (c.feeRules?.installments ?? 1) > 1
  ) {
    errors['feeRules.installments'] = ['Chỉ khóa trọn gói mới chia đợt.'];
  }
  // Tổng số buổi của khóa = số buổi theo lịch từ ngày bắt đầu đến kết thúc: cần cả hai.
  if (c.feeType === 'course' && (!c.endDate || c.scheduleRuleCount < 1)) {
    errors.feeType = [
      'Khóa trọn gói cần ngày kết thúc và ít nhất một quy tắc lịch học.',
    ];
  }
  return errors;
}
