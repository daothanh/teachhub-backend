import { describe, expect, it } from 'vitest';
import { isEnabled, isEnabledForAny } from './notification-settings.js';

describe('isEnabled', () => {
  it('khóa thiếu hoặc settings null → bật', () => {
    expect(isEnabled(null, 'student_absent')).toBe(true);
    expect(isEnabled({}, 'invoice_issued')).toBe(true);
  });

  it('map loại → khóa', () => {
    expect(isEnabled({ absence: false }, 'student_absent')).toBe(false);
    expect(isEnabled({ absence: false }, 'student_absent_correction')).toBe(
      false,
    );
    expect(isEnabled({ schedule: false }, 'schedule_changed')).toBe(false);
    expect(isEnabled({ invoice: false }, 'invoice_issued')).toBe(false);
    expect(isEnabled({ dunning: false }, 'payment_reminder')).toBe(false);
  });

  it('khóa khác không ảnh hưởng', () => {
    expect(isEnabled({ invoice: false }, 'payment_reminder')).toBe(true);
  });

  it('loại không gắn lớp luôn bật', () => {
    expect(isEnabled({ absence: false }, 'payment_recorded')).toBe(true);
  });
});

describe('isEnabledForAny', () => {
  it('không có lớp liên quan → gửi', () => {
    expect(isEnabledForAny([], 'invoice_issued')).toBe(true);
  });

  it('chỉ bỏ khi mọi lớp đều tắt', () => {
    const off = { invoice: false };
    expect(isEnabledForAny([off, off], 'invoice_issued')).toBe(false);
    expect(isEnabledForAny([off, {}], 'invoice_issued')).toBe(true);
  });
});
