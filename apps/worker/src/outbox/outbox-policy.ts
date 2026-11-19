/** Số lần relay thử đẩy một sự kiện sang BullMQ trước khi đánh dấu `failed_at`. */
export const OUTBOX_MAX_ATTEMPTS = 8;

const BASE_MS = 1_000;
const CAP_MS = 5 * 60_000;

/** Backoff lũy thừa sau lần thử thứ `attempts` (1 → 2 s, 2 → 4 s …), chặn trên 5 phút. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_MS * 2 ** attempts, CAP_MS);
}

export type FailureOutcome =
  { failed: true } | { failed: false; retryInMs: number };

/** Sau một lần đẩy lỗi (`attempts` đã tính lần vừa rồi): hết lượt thì bỏ cuộc, còn thì hẹn thử lại. */
export function outcomeAfterFailure(attempts: number): FailureOutcome {
  return attempts >= OUTBOX_MAX_ATTEMPTS
    ? { failed: true }
    : { failed: false, retryInMs: backoffMs(attempts) };
}

/** Sự kiện khẩn (báo vắng, NFR-02) đi hàng đợi riêng, tách khỏi tác vụ nặng. */
const URGENT_TYPES = new Set(['attendance_recorded']);

export const OUTBOX_QUEUE_URGENT = 'urgent';
export const OUTBOX_QUEUE_DEFAULT = 'events';

export function queueFor(type: string): string {
  return URGENT_TYPES.has(type) ? OUTBOX_QUEUE_URGENT : OUTBOX_QUEUE_DEFAULT;
}
