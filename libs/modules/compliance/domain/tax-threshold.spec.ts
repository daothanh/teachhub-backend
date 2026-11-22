import {
  progressPercent,
  TAX_THRESHOLDS,
  thresholdStatus,
} from './tax-threshold.js';

const [t500, t1b] = TAX_THRESHOLDS;

describe('thresholdStatus', () => {
  it('đúng biên 80% và 100% của ngưỡng 500 triệu', () => {
    expect(thresholdStatus(399_999_999, t500)).toBe('below');
    expect(thresholdStatus(400_000_000, t500)).toBe('warning');
    expect(thresholdStatus(499_999_999, t500)).toBe('warning');
    expect(thresholdStatus(500_000_000, t500)).toBe('exceeded');
  });
  it('đúng biên của ngưỡng 1 tỷ', () => {
    expect(thresholdStatus(799_999_999, t1b)).toBe('below');
    expect(thresholdStatus(800_000_000, t1b)).toBe('warning');
    expect(thresholdStatus(1_000_000_000, t1b)).toBe('exceeded');
  });
  it('lũy kế âm là below', () => {
    expect(thresholdStatus(-5, t500)).toBe('below');
  });
});

describe('progressPercent', () => {
  it('một chữ số thập phân, không chặn ở 100', () => {
    expect(progressPercent(400_000_000, 500_000_000)).toBe(80);
    expect(progressPercent(123_456_789, 500_000_000)).toBe(24.7);
    expect(progressPercent(750_000_000, 500_000_000)).toBe(150);
  });
  it('0 khi lũy kế không dương', () => {
    expect(progressPercent(0, 500_000_000)).toBe(0);
    expect(progressPercent(-1, 500_000_000)).toBe(0);
  });
});
