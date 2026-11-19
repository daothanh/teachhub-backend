import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  JOB_PURGE_IDEMPOTENCY,
  PurgeIdempotencyKeysJob,
} from '@teachhub/infra';
import {
  GenerateSessionsJob,
  JOB_GENERATE_SESSIONS,
} from '@teachhub/modules/schedule';

export const CRON_QUEUE = 'cron';
const TZ = 'Asia/Ho_Chi_Minh';

/** Job định kỳ (cron theo giờ Việt Nam). Mỗi job tự ghi `job_runs`; BullMQ thử lại khi ném lỗi. */
@Processor(CRON_QUEUE)
@Injectable()
export class CronProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    @InjectQueue(CRON_QUEUE) private readonly queue: Queue,
    private readonly generate: GenerateSessionsJob,
    private readonly purge: PurgeIdempotencyKeysJob,
  ) {
    super();
  }

  /** `upsertJobScheduler` theo id: nhiều instance worker khởi động vẫn chỉ có một lịch. */
  async onApplicationBootstrap(): Promise<void> {
    const opts = {
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    };
    await this.queue.upsertJobScheduler(
      JOB_GENERATE_SESSIONS,
      { pattern: '0 1 * * *', tz: TZ },
      { name: JOB_GENERATE_SESSIONS, opts },
    );
    await this.queue.upsertJobScheduler(
      JOB_PURGE_IDEMPOTENCY,
      { pattern: '30 1 * * *', tz: TZ },
      { name: JOB_PURGE_IDEMPOTENCY, opts },
    );
  }

  async process(job: Job): Promise<number> {
    switch (job.name) {
      case JOB_GENERATE_SESSIONS:
        return this.generate.run();
      case JOB_PURGE_IDEMPOTENCY:
        return this.purge.run();
      default:
        throw new Error(`Job không biết: ${job.name}`);
    }
  }
}
