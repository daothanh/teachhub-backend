import { describe, expect, it } from 'vitest';
import {
  isPayable,
  overpaidOf,
  overpaymentDelta,
  remainingOf,
  statusAfter,
} from './payment.js';

describe('thu tiền: hàm thuần', () => {
  it('trạng thái theo Σ thanh toán (US-7.4 AC1, AC2)', () => {
    expect(statusAfter(1_200_000, 0)).toBe('issued');
    expect(statusAfter(1_200_000, 500_000)).toBe('partially_paid');
    expect(statusAfter(1_200_000, 1_199_999)).toBe('partially_paid');
    expect(statusAfter(1_200_000, 1_200_000)).toBe('paid');
    expect(statusAfter(1_200_000, 1_500_000)).toBe('paid');
  });

  it('còn nợ và trả thừa không âm', () => {
    expect(remainingOf(1_200_000, 500_000)).toBe(700_000);
    expect(remainingOf(1_200_000, 1_500_000)).toBe(0);
    expect(overpaidOf(1_200_000, 1_500_000)).toBe(300_000);
    expect(overpaidOf(1_200_000, 500_000)).toBe(0);
  });

  it('chỉ issued, partially_paid, pending_confirmation nhận thanh toán', () => {
    for (const s of ['issued', 'partially_paid', 'pending_confirmation'])
      expect(isPayable(s)).toBe(true);
    for (const s of ['draft', 'void', 'paid']) expect(isPayable(s)).toBe(false);
  });

  it('delta sổ học viên: thu thừa ghi có, hủy ghi nợ đúng phần đã ghi có', () => {
    const total = 1_000_000;
    // 600k rồi 900k (tổng 1,5 tr, thừa 500k).
    expect(overpaymentDelta(total, 0, 600_000)).toBe(0);
    expect(overpaymentDelta(total, 600_000, 1_500_000)).toBe(500_000);
    // Hủy lần 600k: còn 900k < total, đảo toàn bộ 500k.
    expect(overpaymentDelta(total, 1_500_000, 900_000)).toBe(-500_000);
    // Hủy lần 900k: còn 600k, đảo 500k.
    expect(overpaymentDelta(total, 1_500_000, 600_000)).toBe(-500_000);
    // Hủy một khoản nhỏ mà vẫn thừa: chỉ đảo phần chênh.
    expect(overpaymentDelta(total, 2_100_000, 2_000_000)).toBe(-100_000);
  });
});
