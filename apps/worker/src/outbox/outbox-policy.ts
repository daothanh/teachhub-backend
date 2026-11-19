/** Số lần relay thử đẩy một sự kiện (lỗi riêng của sự kiện) trước khi đánh dấu `failed_at`. */
export const OUTBOX_MAX_ATTEMPTS = 8;

const BASE_MS = 1_000;
const CAP_MS = 5 * 60_000;

/** Backoff lũy thừa sau lần thử thứ `n` (1 → 2 s, 2 → 4 s …), chặn trên 5 phút. */
export function backoffMs(n: number): number {
  return Math.min(BASE_MS * 2 ** n, CAP_MS);
}

/** Backoff khi hạ tầng (Redis) lỗi cả lô: như `backoffMs` nhưng có jitter 50–100% để các bản sao không dồn cùng lúc. */
export function infraBackoffMs(failures: number, rand = Math.random): number {
  return Math.round(backoffMs(failures) * (0.5 + rand() / 2));
}

export type FailureOutcome =
  { failed: true } | { failed: false; retryInMs: number };

/**
 * Sau một lần đẩy lỗi riêng của sự kiện (`attempts` đã tính lần vừa rồi): hết lượt thì bỏ cuộc, còn thì hẹn thử lại.
 * Sự kiện khẩn không bao giờ bị đánh `failed_at` (mất báo vắng là không chấp nhận được): chỉ backoff trần.
 */
export function outcomeAfterFailure(
  attempts: number,
  urgent: boolean,
): FailureOutcome {
  return attempts >= OUTBOX_MAX_ATTEMPTS && !urgent
    ? { failed: true }
    : { failed: false, retryInMs: backoffMs(attempts) };
}

/**
 * Lỗi riêng của sự kiện (dữ liệu không serialize được, tham số sai) khác lỗi hạ tầng (Redis đứt, timeout).
 * shortcut: nhận diện theo loại lỗi JS, mọi lỗi khác coi là hạ tầng (không đốt attempts); tinh chỉnh khi gặp ca thực tế.
 */
export function isEventError(e: unknown): boolean {
  return (
    e instanceof TypeError ||
    e instanceof RangeError ||
    e instanceof SyntaxError
  );
}

/** Sự kiện khẩn (báo vắng, NFR-02) đi hàng đợi riêng, tách khỏi tác vụ nặng. */
const URGENT_TYPES = new Set(['attendance_recorded']);

export const OUTBOX_QUEUE_URGENT = 'urgent';
export const OUTBOX_QUEUE_DEFAULT = 'events';
export type OutboxQueueName =
  typeof OUTBOX_QUEUE_URGENT | typeof OUTBOX_QUEUE_DEFAULT;

export function queueFor(type: string): OutboxQueueName {
  return URGENT_TYPES.has(type) ? OUTBOX_QUEUE_URGENT : OUTBOX_QUEUE_DEFAULT;
}
