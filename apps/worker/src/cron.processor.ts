import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { captureJobFailure } from '@teachhub/core';
import {
  JOB_PURGE_IDEMPOTENCY,
  PurgeIdempotencyKeysJob,
} from '@teachhub/infra';
import {
  BillingCloseJob,
  BillingReconcileJob,
  DunningJob,
  JOB_BILLING_CLOSE,
  JOB_BILLING_DUNNING,
  JOB_BILLING_RECONCILE,
} from '@teachhub/modules/billing';
import {
  JOB_COMPLIANCE_TAX_THRESHOLD,
  TaxThresholdJob,
} from '@teachhub/modules/compliance';
import {
  JOB_PURGE_STALE_DEVICES,
  PurgeStaleDevicesJob,
} from '@teachhub/modules/notifications';
import {
  JOB_SUBSCRIPTION_LIFECYCLE,
  SubscriptionLifecycleJob,
} from '@teachhub/modules/subscription';
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
    private readonly billingClose: BillingCloseJob,
    private readonly billingReconcile: BillingReconcileJob,
    private readonly dunning: DunningJob,
    private readonly purge: PurgeIdempotencyKeysJob,
    private readonly purgeDevices: PurgeStaleDevicesJob,
    private readonly lifecycle: SubscriptionLifecycleJob,
    private readonly taxThreshold: TaxThresholdJob,
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
      JOB_BILLING_CLOSE,
      { pattern: '0 2 * * *', tz: TZ },
      { name: JOB_BILLING_CLOSE, opts },
    );
    // Mỗi 15 phút từ 07:00 đến 21:30; job tự bỏ lần 21:45 vì ngoài khung.
    await this.queue.upsertJobScheduler(
      JOB_BILLING_DUNNING,
      { pattern: '*/15 7-21 * * *', tz: TZ },
      { name: JOB_BILLING_DUNNING, opts },
    );
    await this.queue.upsertJobScheduler(
      JOB_BILLING_RECONCILE,
      { pattern: '0 3 * * *', tz: TZ },
      { name: JOB_BILLING_RECONCILE, opts },
    );
    await this.queue.upsertJobScheduler(
      JOB_SUBSCRIPTION_LIFECYCLE,
      { pattern: '0 6 * * *', tz: TZ },
      { name: JOB_SUBSCRIPTION_LIFECYCLE, opts },
    );
    // 08:00: trong khung giờ yên lặng của push (07:00 đến 21:30).
    await this.queue.upsertJobScheduler(
      JOB_COMPLIANCE_TAX_THRESHOLD,
      { pattern: '0 8 * * *', tz: TZ },
      { name: JOB_COMPLIANCE_TAX_THRESHOLD, opts },
    );
    await this.queue.upsertJobScheduler(
      JOB_PURGE_IDEMPOTENCY,
      { pattern: '30 1 * * *', tz: TZ },
      { name: JOB_PURGE_IDEMPOTENCY, opts },
    );
    await this.queue.upsertJobScheduler(
      JOB_PURGE_STALE_DEVICES,
      { pattern: '45 1 * * *', tz: TZ },
      { name: JOB_PURGE_STALE_DEVICES, opts },
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    captureJobFailure(job, err);
  }

  async process(job: Job): Promise<number> {
    switch (job.name) {
      case JOB_GENERATE_SESSIONS:
        return this.generate.run();
      case JOB_BILLING_CLOSE:
        // Mốc thời gian của job cố định qua các lần BullMQ thử lại: kỳ được chọn không đổi giữa lần chạy và lần thử lại.
        return this.billingClose.run(new Date(job.timestamp));
      case JOB_BILLING_RECONCILE:
        return this.billingReconcile.run();
      case JOB_BILLING_DUNNING:
        // Giờ chạy thật, không `job.timestamp`: lần BullMQ thử lại muộn không được coi là còn trong khung giờ gửi.
        return this.dunning.run(new Date());
      case JOB_SUBSCRIPTION_LIFECYCLE:
        // Giờ chạy thật: lần BullMQ thử lại vẫn chốt theo "bây giờ", không theo mốc lập lịch.
        return this.lifecycle.run(new Date());
      case JOB_COMPLIANCE_TAX_THRESHOLD:
        return this.taxThreshold.run();
      case JOB_PURGE_IDEMPOTENCY:
        return this.purge.run();
      case JOB_PURGE_STALE_DEVICES:
        return this.purgeDevices.run();
      default:
        throw new Error(`Job không biết: ${job.name}`);
    }
  }
}
