import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core/uuid.js';
import { TxService } from '@teachhub/db';

export const OUTBOX_RETAIN_DAYS = 7;
export const OUTBOX_PURGE_BATCH = 1_000;
const EVERY_MS = 60 * 60_000;

/**
 * Dọn sự kiện đã gửi quá 7 ngày, xóa theo lô để không giữ khóa lâu, ghi `job_runs`.
 * shortcut: timer trong tiến trình (mỗi bản sao worker chạy, xóa idempotent nhờ skip locked); chuyển sang
 * job scheduler BullMQ `maintenance.cleanup` (Mục 3.6d) khi có hạ tầng lịch chạy.
 */
@Injectable()
export class OutboxCleanupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger(OutboxCleanupService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<unknown> = Promise.resolve();

  constructor(private readonly tx: TxService) {}

  onApplicationBootstrap(): void {
    const tick = (): void => {
      if (this.stopped) return;
      this.running = this.purge()
        .catch((e: unknown) =>
          this.log.error(
            `dọn outbox lỗi: ${e instanceof Error ? e.message : String(e)}`,
          ),
        )
        .then(() => {
          if (!this.stopped) this.timer = setTimeout(tick, EVERY_MS);
        });
    };
    tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Xóa theo lô tới khi hết; trả tổng số dòng đã xóa. */
  async purge(days = OUTBOX_RETAIN_DAYS): Promise<number> {
    const runId = uuidv7();
    await this.tx.run({ userId: null }, (tx) =>
      tx.execute(
        sql`insert into job_runs (id, job, status) values (${runId}, 'outbox.cleanup', 'running')`,
      ),
    );
    let total = 0;
    try {
      for (;;) {
        const n = await this.tx.run({ userId: null }, async (tx) => {
          const r = await tx.execute(sql`
            delete from outbox_events where id in (
              select id from outbox_events
              where dispatched_at < now() - ${days} * interval '1 day'
              limit ${OUTBOX_PURGE_BATCH} for update skip locked)`);
          return r.rowCount ?? 0;
        });
        total += n;
        if (n < OUTBOX_PURGE_BATCH) break;
      }
    } catch (e) {
      await this.tx.run({ userId: null }, (tx) =>
        tx.execute(
          sql`update job_runs set status = 'failed', finished_at = now(), rows_affected = ${total},
              error = ${e instanceof Error ? e.message : String(e)} where id = ${runId}`,
        ),
      );
      throw e;
    }
    await this.tx.run({ userId: null }, (tx) =>
      tx.execute(
        sql`update job_runs set status = 'succeeded', finished_at = now(), rows_affected = ${total} where id = ${runId}`,
      ),
    );
    return total;
  }
}
