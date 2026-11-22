import { Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { files, TxService } from '@teachhub/db';
import { JobRuns, ObjectStorage } from '@teachhub/infra';
import { PENDING_TTL_HOURS } from '../domain/file-policy.js';

export const JOB_PURGE_PENDING_FILES = 'files.purge-pending';
const BATCH = 200;

/**
 * Dọn tệp `pending` quá 24 giờ chưa `complete` (Spec §3.6c): xóa đối tượng khỏi kho S3 rồi xóa dòng `files`. Chạy bằng role
 * worker (BYPASSRLS, chỉ role này được xóa `files`) nên lọc `status = 'pending'` tường minh ở cả truy vấn chọn lẫn xóa: tệp vừa
 * `complete` giữa hai bước không bị xóa. Xóa đối tượng lỗi → giữ dòng, lần chạy sau thử lại (S3 xóa idempotent).
 */
@Injectable()
export class PurgePendingFilesJob {
  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
    private readonly storage: ObjectStorage,
  ) {}

  run(): Promise<number> {
    return this.runs.track(JOB_PURGE_PENDING_FILES, async () => {
      let total = 0;
      const skipped = new Set<string>();
      for (;;) {
        const stale = (
          await this.tx.run({ userId: null }, (t) =>
            t
              .select({ id: files.id, key: files.objectKey })
              .from(files)
              .where(
                and(
                  eq(files.status, 'pending'),
                  lt(
                    files.createdAt,
                    sql`now() - make_interval(hours => ${PENDING_TTL_HOURS})`,
                  ),
                ),
              )
              .orderBy(files.createdAt)
              .limit(BATCH + skipped.size),
          )
        ).filter((f) => !skipped.has(f.id));
        const gone: string[] = [];
        for (const f of stale.slice(0, BATCH)) {
          try {
            await this.storage.delete(f.key);
            gone.push(f.id);
          } catch {
            skipped.add(f.id);
          }
        }
        if (gone.length)
          total += (
            await this.tx.run({ userId: null }, (t) =>
              t
                .delete(files)
                .where(
                  and(inArray(files.id, gone), eq(files.status, 'pending')),
                )
                .returning({ id: files.id }),
            )
          ).length;
        if (stale.length < BATCH) return total;
      }
    });
  }
}
