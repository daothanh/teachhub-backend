import {
  daysLeft,
  effectiveStatus,
  exceedsLimit,
  overLimit,
  planCodeOf,
} from './plan.js';

const now = new Date('2027-03-01T10:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('effectiveStatus / planCodeOf', () => {
  it('active/trialing còn hạn giữ nguyên, quá hạn (hoặc đúng hạn) thành expired', () => {
    expect(
      effectiveStatus({ status: 'active', currentPeriodEnd: at(1) }, now),
    ).toBe('active');
    expect(
      effectiveStatus({ status: 'trialing', currentPeriodEnd: at(0) }, now),
    ).toBe('expired');
    expect(
      effectiveStatus({ status: 'active', currentPeriodEnd: at(-1) }, now),
    ).toBe('expired');
  });
  it('không có hạn: giữ nguyên; free/expired không đổi', () => {
    expect(
      effectiveStatus({ status: 'active', currentPeriodEnd: null }, now),
    ).toBe('active');
    expect(
      effectiveStatus({ status: 'free', currentPeriodEnd: null }, now),
    ).toBe('free');
    expect(
      effectiveStatus({ status: 'expired', currentPeriodEnd: at(1) }, now),
    ).toBe('expired');
  });
  it('chỉ trialing/active là pro', () => {
    expect(planCodeOf('trialing')).toBe('pro');
    expect(planCodeOf('active')).toBe('pro');
    expect(planCodeOf('free')).toBe('free');
    expect(planCodeOf('expired')).toBe('free');
  });
});

describe('daysLeft / giới hạn', () => {
  it('làm tròn lên, không âm', () => {
    expect(daysLeft(at(14 * 86_400_000), now)).toBe(14);
    expect(daysLeft(at(86_400_000 + 60_001), now)).toBe(2);
    // Lệch đồng hồ DB/app vài giây không làm 14 ngày thành 15.
    expect(daysLeft(at(14 * 86_400_000 + 5_000), now)).toBe(14);
    expect(daysLeft(at(-5), now)).toBe(0);
  });
  it('exceedsLimit: null = không giới hạn; 3/3 thêm 1 là vượt, 2/3 thêm 1 thì không', () => {
    expect(exceedsLimit(99, 1, null)).toBe(false);
    expect(exceedsLimit(3, 1, 3)).toBe(true);
    expect(exceedsLimit(2, 1, 3)).toBe(false);
    expect(exceedsLimit(18, 3, 20)).toBe(true);
  });
  it('overLimit: phần vượt chuyển chỉ đọc', () => {
    expect(overLimit(5, 3)).toBe(2);
    expect(overLimit(3, 3)).toBe(0);
    expect(overLimit(50, null)).toBe(0);
  });
});
