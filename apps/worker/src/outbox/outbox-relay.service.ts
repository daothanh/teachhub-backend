import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { TxService } from '@teachhub/db';
import {
  OUTBOX_QUEUE_DEFAULT,
  OUTBOX_QUEUE_URGENT,
  outcomeAfterFailure,
  queueFor,
} from './outbox-policy.js';

export const OUTBOX_BATCH_SIZE = 100;
/** Quét định kỳ (Mục 6.2: dự phòng 1 giây). shortcut: chưa có LISTEN/NOTIFY, thêm khi p95 báo vắng cần dưới 1 giây. */
export const OUTBOX_POLL_MS = 1_000;

interface PendingRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

/**
 * Relay: khóa lô sự kiện chưa gửi (`FOR UPDATE SKIP LOCKED` nên nhiều bản sao worker không giẫm nhau),
 * đẩy sang BullMQ rồi đánh dấu `dispatched_at` trong cùng giao dịch. `jobId = id sự kiện` khiến BullMQ
 * bỏ qua job trùng nếu worker chết giữa lúc `add` và `commit` → tối đa một job cho mỗi sự kiện
 * (consumer vẫn cần idempotent vì BullMQ giao ít nhất một lần).
 */
@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<unknown> = Promise.resolve();
  private readonly queues: Record<string, Queue>;

  constructor(
    private readonly tx: TxService,
    @InjectQueue(OUTBOX_QUEUE_URGENT) urgent: Queue,
    @InjectQueue(OUTBOX_QUEUE_DEFAULT) events: Queue,
  ) {
    this.queues = {
      [OUTBOX_QUEUE_URGENT]: urgent,
      [OUTBOX_QUEUE_DEFAULT]: events,
    };
  }

  onApplicationBootstrap(): void {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.relayBatch()
        .catch((e: unknown) =>
          this.log.error(
            `relay lỗi: ${e instanceof Error ? e.message : String(e)}`,
          ),
        )
        .then(() => {
          this.timer = setTimeout(tick, OUTBOX_POLL_MS);
        });
    };
    tick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Xử lý một lô; trả số sự kiện đã lấy (kể cả lần thử lỗi). */
  relayBatch(limit = OUTBOX_BATCH_SIZE): Promise<number> {
    return this.tx.run({ userId: null }, async (tx) => {
      const { rows } = await tx.execute<PendingRow>(sql`
        select id, tenant_id, type, payload, attempts from outbox_events
        where dispatched_at is null and failed_at is null and next_attempt_at <= now()
        order by next_attempt_at, id
        limit ${limit}
        for update skip locked`);
      for (const ev of rows) {
        try {
          await this.queues[queueFor(ev.type)]!.add(
            ev.type,
            { eventId: ev.id, tenantId: ev.tenant_id, payload: ev.payload },
            { jobId: ev.id, removeOnComplete: { age: 3600 } },
          );
          await tx.execute(
            sql`update outbox_events set dispatched_at = now() where id = ${ev.id}`,
          );
        } catch (e) {
          const attempts = ev.attempts + 1;
          const outcome = outcomeAfterFailure(attempts);
          // Không ghi payload vào log; chỉ id + lý do.
          const message = e instanceof Error ? e.message : String(e);
          this.log.warn(
            `đẩy outbox ${ev.id} lỗi (lần ${attempts}): ${message}`,
          );
          await tx.execute(
            outcome.failed
              ? sql`update outbox_events set attempts = ${attempts}, last_error = ${message}, failed_at = now() where id = ${ev.id}`
              : sql`update outbox_events set attempts = ${attempts}, last_error = ${message},
                    next_attempt_at = now() + ${outcome.retryInMs} * interval '1 millisecond' where id = ${ev.id}`,
          );
        }
      }
      return rows.length;
    });
  }
}
