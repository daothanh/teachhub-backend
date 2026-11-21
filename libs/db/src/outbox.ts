import { uuidv7 } from '@teachhub/core/uuid.js'; // không qua index: tránh nạp CoreModule (đọc env) khi import lib db
import type { Tx } from './tx.service.js';
import { outboxEvents } from './schema/index.js';

export interface OutboxEventInput {
  tenantId: string;
  /** Tên sự kiện, vd `attendance_recorded`. */
  type: string;
  /** Chỉ chứa dữ liệu tối thiểu để consumer xử lý (không nhét dữ liệu nhạy cảm). */
  payload: Record<string, unknown>;
  /** Hẹn giờ đẩy (relay chỉ lấy sự kiện có `next_attempt_at` ≤ bây giờ); bỏ trống = đẩy ngay. Dùng cho tin chờ hết giờ yên lặng. */
  deliverAt?: Date;
}

/**
 * shortcut: policy insert của outbox_events cho mọi nhân sự của tenant, chưa tách theo vai trò; đủ vì chỉ code server ghi.
 *
 * Ghi sự kiện outbox trong CÙNG giao dịch với lệnh nghiệp vụ: `tx` lấy từ `TxService.run`,
 * giao dịch rollback thì sự kiện cũng mất. Trả về id sự kiện.
 */
export async function recordOutboxEvent(
  tx: Tx,
  event: OutboxEventInput,
): Promise<string> {
  const id = uuidv7();
  const { deliverAt, ...rest } = event;
  await tx
    .insert(outboxEvents)
    .values({ id, ...rest, ...(deliverAt && { nextAttemptAt: deliverAt }) });
  return id;
}
