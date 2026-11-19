import {
  OUTBOX_MAX_ATTEMPTS,
  backoffMs,
  outcomeAfterFailure,
  queueFor,
} from './outbox-policy.js';

describe('outbox policy', () => {
  it('backoff tăng lũy thừa và bị chặn ở 5 phút', () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(30)).toBe(300_000);
  });

  it('lỗi chưa hết lượt → hẹn thử lại; hết lượt → failed', () => {
    expect(outcomeAfterFailure(1)).toEqual({ failed: false, retryInMs: 2_000 });
    expect(outcomeAfterFailure(OUTBOX_MAX_ATTEMPTS - 1).failed).toBe(false);
    expect(outcomeAfterFailure(OUTBOX_MAX_ATTEMPTS)).toEqual({ failed: true });
  });

  it('báo vắng đi hàng urgent, còn lại hàng events', () => {
    expect(queueFor('attendance_recorded')).toBe('urgent');
    expect(queueFor('invoice_issued')).toBe('events');
  });
});
