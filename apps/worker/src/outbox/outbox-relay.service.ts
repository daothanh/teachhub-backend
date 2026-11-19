import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { type SQL, sql } from 'drizzle-orm';
import { TxService } from '@teachhub/db';
import {
  OUTBOX_QUEUE_DEFAULT,
  OUTBOX_QUEUE_URGENT,
  type OutboxQueueName,
  infraBackoffMs,
  isEventError,
  outcomeAfterFailure,
  queueFor,
} from './outbox-policy.js';

export const OUTBOX_BATCH_SIZE = 100;
/** Quét định kỳ (Mục 6.2: dự phòng 1 giây). shortcut: chưa có LISTEN/NOTIFY, thêm khi p95 báo vắng cần dưới 1 giây. */
export const OUTBOX_POLL_MS = 1_000;
/** Thời gian giữ chỗ một lô đã claim; phải lớn hơn timeout đẩy sang Redis. Worker chết thì sau lease lô được lấy lại. */
export const OUTBOX_LEASE_MS = 60_000;
export const OUTBOX_ADD_TIMEOUT_MS = 5_000;

interface PendingRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

const idList = (ids: string[]): SQL =>
  sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  );

/**
 * Relay outbox → BullMQ, ba bước để không giữ khóa dòng trong lúc gọi Redis:
 * 1. claim (tx ngắn): `FOR UPDATE SKIP LOCKED` rồi đẩy `next_attempt_at` ra sau một lease, nên nhiều bản sao worker không lấy trùng;
 * 2. `add` sang BullMQ ngoài giao dịch, có timeout; `jobId = id sự kiện` nên BullMQ bỏ qua job trùng khi lô được lấy lại;
 * 3. đánh dấu kết quả (tx ngắn): thành công → `dispatched_at`; lỗi → lùi `next_attempt_at`.
 *
 * Lỗi hạ tầng (Redis đứt, timeout) là lỗi chung của lô: chỉ lùi lịch có jitter, KHÔNG tăng `attempts`.
 * Chỉ lỗi riêng của sự kiện mới tăng `attempts`; quá giới hạn thì `failed_at` (trừ hàng urgent: chỉ backoff trần).
 *
 * Bảo đảm: giao ít nhất một lần, KHÔNG bảo đảm thứ tự giữa các sự kiện. Consumer phải idempotent theo `eventId`.
 */
@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<unknown> = Promise.resolve();
  private infraFailures = 0;
  private lastBatchInfraFailed = false;
  private readonly queues: Record<OutboxQueueName, Queue>;
  /** Public để test chỉnh nhỏ lại. */
  leaseMs = OUTBOX_LEASE_MS;
  addTimeoutMs = OUTBOX_ADD_TIMEOUT_MS;

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
    for (const name of [OUTBOX_QUEUE_URGENT, OUTBOX_QUEUE_DEFAULT] as const)
      if (!this.queues[name])
        throw new Error(`Thiếu hàng đợi outbox "${name}"`);
    const tick = (): void => {
      if (this.stopped) return;
      this.running = this.relayBatch()
        .catch((e: unknown) => {
          this.log.error(
            `relay lỗi: ${e instanceof Error ? e.message : String(e)}`,
          );
          return 0;
        })
        .then((claimed) => {
          if (this.stopped) return;
          // Lô đầy và Redis ổn → còn việc, chạy tiếp ngay; có lỗi hạ tầng thì chờ chu kỳ quét, không quay vòng sát.
          this.timer = setTimeout(
            tick,
            claimed >= OUTBOX_BATCH_SIZE && !this.lastBatchInfraFailed
              ? 0
              : OUTBOX_POLL_MS,
          );
        });
    };
    tick();
  }

  /** Chạy trước khi BullMQ đóng queue: dừng vòng lặp rồi chờ lô đang xử lý xong. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Đưa lại sự kiện đã `failed_at` về hàng chờ (tất cả, hoặc theo danh sách id). Trả số dòng. */
  requeueFailed(eventIds?: string[]): Promise<number> {
    const only = eventIds ? sql`and id in (${idList(eventIds)})` : sql``;
    return this.tx.run({ userId: null }, async (tx) => {
      const r = await tx.execute(
        sql`update outbox_events set failed_at = null, attempts = 0, next_attempt_at = now()
            where failed_at is not null ${only}`,
      );
      return r.rowCount ?? 0;
    });
  }

  /** Xử lý một lô; trả số sự kiện đã claim. */
  async relayBatch(limit = OUTBOX_BATCH_SIZE): Promise<number> {
    const rows = await this.claim(limit);
    if (rows.length === 0) return 0;

    const sent: string[] = [];
    const infraFailed: string[] = [];
    const eventFailed: { ev: PendingRow; message: string }[] = [];
    await Promise.all(
      rows.map(async (ev) => {
        try {
          await this.add(ev);
          sent.push(ev.id);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (isEventError(e)) eventFailed.push({ ev, message });
          else infraFailed.push(ev.id);
        }
      }),
    );
    this.lastBatchInfraFailed = infraFailed.length > 0;
    if (infraFailed.length > 0) {
      this.infraFailures = sent.length > 0 ? 0 : this.infraFailures + 1;
      this.log.warn(
        `Redis lỗi, lùi ${infraFailed.length} sự kiện (lần liên tiếp ${this.infraFailures})`,
      );
    } else if (sent.length > 0) this.infraFailures = 0;

    await this.tx.run({ userId: null }, async (tx) => {
      if (sent.length > 0)
        await tx.execute(
          sql`update outbox_events set dispatched_at = now() where id in (${idList(sent)})`,
        );
      if (infraFailed.length > 0)
        await tx.execute(
          sql`update outbox_events set next_attempt_at = now() + ${infraBackoffMs(this.infraFailures)} * interval '1 millisecond'
              where id in (${idList(infraFailed)}) and dispatched_at is null`,
        );
      for (const { ev, message } of eventFailed) {
        const attempts = ev.attempts + 1;
        const outcome = outcomeAfterFailure(
          attempts,
          queueFor(ev.type) === OUTBOX_QUEUE_URGENT,
        );
        // Không ghi payload vào log; chỉ id + lý do.
        if (outcome.failed)
          this.log.error(`outbox ${ev.id} quá ${attempts} lần: ${message}`);
        else this.log.warn(`outbox ${ev.id} lỗi lần ${attempts}: ${message}`);
        await tx.execute(
          outcome.failed
            ? sql`update outbox_events set attempts = ${attempts}, last_error = ${message}, failed_at = now() where id = ${ev.id} and dispatched_at is null`
            : sql`update outbox_events set attempts = ${attempts}, last_error = ${message},
                  next_attempt_at = now() + ${outcome.retryInMs} * interval '1 millisecond' where id = ${ev.id} and dispatched_at is null`,
        );
      }
    });
    return rows.length;
  }

  private async claim(limit: number): Promise<PendingRow[]> {
    return this.tx.run({ userId: null }, async (tx) => {
      const r = await tx.execute<PendingRow>(sql`
        with c as (
          select id from outbox_events
          where dispatched_at is null and failed_at is null and next_attempt_at <= now()
          order by next_attempt_at, id
          limit ${limit}
          for update skip locked)
        update outbox_events o
           set next_attempt_at = now() + ${this.leaseMs} * interval '1 millisecond'
          from c where o.id = c.id
        returning o.id, o.tenant_id, o.type, o.payload, o.attempts`);
      return r.rows;
    });
  }

  private async add(ev: PendingRow): Promise<void> {
    const data = {
      eventId: ev.id,
      tenantId: ev.tenant_id,
      payload: ev.payload,
    };
    JSON.stringify(data); // TypeError nếu không serialize được → lỗi riêng của sự kiện
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timeout đẩy sang Redis')),
        this.addTimeoutMs,
      );
    });
    try {
      await Promise.race([
        this.queues[queueFor(ev.type)].add(ev.type, data, {
          jobId: ev.id,
          // shortcut: job xong giữ 1 giờ; sau đó BullMQ không còn nhớ jobId nên sự kiện được lấy lại muộn hơn 1 giờ sẽ chạy lại. Consumer đã idempotent theo eventId.
          removeOnComplete: { age: 3600 },
          // Hàng `events` chưa có consumer đầy đủ: giữ tối đa 500 job lỗi để xem lại, không phình Redis. Hàng khẩn giữ hết.
          ...(queueFor(ev.type) === OUTBOX_QUEUE_DEFAULT && {
            removeOnFail: 500,
          }),
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
