import { Injectable, Module } from '@nestjs/common';
import { eq, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import { idempotencyKeys, jobRuns, TxService } from '@teachhub/db';

/** Chỉ giữ lỗi gốc của driver (không có `params` mang PII) và cắt ngắn. */
const errorText = (e: unknown): string => {
  const base = e instanceof Error ? (e.cause ?? e) : e;
  return (base instanceof Error ? base.message : String(base)).slice(0, 500);
};

/** Ghi `job_runs` quanh mỗi lần chạy job nền (Technical Spec §6.7); chạy bằng role worker. */
@Injectable()
export class JobRuns {
  constructor(private readonly tx: TxService) {}

  /** `fn` trả số dòng tác động. Lỗi được ghi `failed` rồi ném lại để BullMQ thử lại. */
  async track(job: string, fn: () => Promise<number>): Promise<number> {
    const id = uuidv7();
    await this.tx.run({ userId: null }, (t) =>
      t.insert(jobRuns).values({ id, job, status: 'running' }),
    );
    try {
      const rows = await fn();
      await this.finish(id, { status: 'succeeded', rowsAffected: rows });
      return rows;
    } catch (e) {
      await this.finish(id, { status: 'failed', error: errorText(e) });
      throw e;
    }
  }

  private finish(
    id: string,
    set: { status: string; rowsAffected?: number; error?: string },
  ) {
    return this.tx.run({ userId: null }, (t) =>
      t
        .update(jobRuns)
        .set({ ...set, finishedAt: sql`now()` })
        .where(eq(jobRuns.id, id)),
    );
  }
}

export const JOB_PURGE_IDEMPOTENCY = 'infra.purge-idempotency-keys';
const IDEMPOTENCY_TTL_HOURS = 48;

/** Xóa kết quả `Idempotency-Key` quá 48 giờ (client không thử lại muộn hơn thế). */
@Injectable()
export class PurgeIdempotencyKeysJob {
  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  run(): Promise<number> {
    return this.runs.track(JOB_PURGE_IDEMPOTENCY, async () => {
      const gone = await this.tx.run({ userId: null }, (t) =>
        t
          .delete(idempotencyKeys)
          .where(
            lt(
              idempotencyKeys.createdAt,
              sql`now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`,
            ),
          )
          .returning({ id: idempotencyKeys.id }),
      );
      return gone.length;
    });
  }
}

@Module({
  providers: [JobRuns, PurgeIdempotencyKeysJob],
  exports: [JobRuns, PurgeIdempotencyKeysJob],
})
export class JobsModule {}
