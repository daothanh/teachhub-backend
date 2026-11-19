import {
  OUTBOX_MAX_ATTEMPTS,
  backoffMs,
  infraBackoffMs,
  isEventError,
  outcomeAfterFailure,
  queueFor,
} from './outbox-policy.js';

describe('outbox policy', () => {
  it('backoff tăng lũy thừa và bị chặn ở 5 phút', () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(30)).toBe(300_000);
  });

  it('infra backoff có jitter 50–100% và không vượt trần', () => {
    expect(infraBackoffMs(30, () => 0)).toBe(150_000);
    expect(infraBackoffMs(30, () => 1)).toBe(300_000);
  });

  it('lỗi chưa hết lượt → hẹn thử lại; hết lượt → failed, trừ sự kiện khẩn', () => {
    expect(outcomeAfterFailure(1, false)).toEqual({
      failed: false,
      retryInMs: 2_000,
    });
    expect(outcomeAfterFailure(OUTBOX_MAX_ATTEMPTS, false)).toEqual({
      failed: true,
    });
    expect(outcomeAfterFailure(OUTBOX_MAX_ATTEMPTS + 5, true)).toEqual({
      failed: false,
      retryInMs: 300_000,
    });
  });

  it('chỉ TypeError/RangeError/SyntaxError là lỗi riêng của sự kiện', () => {
    expect(isEventError(new TypeError('x'))).toBe(true);
    expect(isEventError(new Error('Connection is closed'))).toBe(false);
  });

  it('báo vắng đi hàng urgent, còn lại hàng events', () => {
    expect(queueFor('attendance_recorded')).toBe('urgent');
    expect(queueFor('invoice_issued')).toBe('events');
  });
});
