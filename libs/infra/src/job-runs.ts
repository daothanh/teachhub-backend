import { Injectable, Module } from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
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
    // Lần chạy trước bị bỏ dở (worker chết giữa chừng) vẫn `running` quá một giờ: đóng lại để dashboard không treo.
    await this.tx.run({ userId: null }, (t) =>
      t
        .update(jobRuns)
        .set({
          status: 'failed',
          error: 'bỏ dở: worker dừng giữa chừng',
          finishedAt: sql`now()`,
        })
        .where(
          and(
            eq(jobRuns.job, job),
            eq(jobRuns.status, 'running'),
            lt(jobRuns.startedAt, sql`now() - interval '1 hour'`),
          ),
        ),
    );
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
export const PURGE_BATCH = 5000;

/** Xóa kết quả `Idempotency-Key` quá 48 giờ (client không thử lại muộn hơn thế). */
@Injectable()
export class PurgeIdempotencyKeysJob {
  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  run(): Promise<number> {
    return this.runs.track(JOB_PURGE_IDEMPOTENCY, async () => {
      let total = 0;
      // Theo lô để một lần xóa không giữ khóa/WAL quá lớn khi tồn đọng nhiều.
      for (;;) {
        const gone = await this.tx.run({ userId: null }, (t) =>
          t
            .delete(idempotencyKeys)
            .where(
              inArray(
                idempotencyKeys.id,
                t
                  .select({ id: idempotencyKeys.id })
                  .from(idempotencyKeys)
                  .where(
                    lt(
                      idempotencyKeys.createdAt,
                      sql`now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`,
                    ),
                  )
                  .limit(PURGE_BATCH),
              ),
            )
            .returning({ id: idempotencyKeys.id }),
        );
        total += gone.length;
        if (gone.length < PURGE_BATCH) return total;
      }
    });
  }
}

export const JOB_ENSURE_AUDIT_PARTITIONS = 'infra.ensure-audit-partitions';

/**
 * Tạo trước phân vùng `audit_logs` của tháng (UTC) chứa `now` và tháng kế tiếp; đã có thì bỏ qua (idempotent).
 * Để `audit_insert` trong giao dịch người dùng không phải tạo phân vùng (khóa ACCESS EXCLUSIVE bảng cha) ngày đầu tháng.
 */
@Injectable()
export class EnsureAuditPartitionsJob {
  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  run(now: Date): Promise<number> {
    return this.runs.track(JOB_ENSURE_AUDIT_PARTITIONS, async () => {
      await this.tx.run({ userId: null }, (t) =>
        t.execute(
          sql`select app_private.ensure_audit_partition(${now.toISOString()}::timestamptz),
                     app_private.ensure_audit_partition(${now.toISOString()}::timestamptz + interval '1 month')`,
        ),
      );
      return 2;
    });
  }
}

@Module({
  providers: [JobRuns, PurgeIdempotencyKeysJob, EnsureAuditPartitionsJob],
  exports: [JobRuns, PurgeIdempotencyKeysJob, EnsureAuditPartitionsJob],
})
export class JobsModule {}
