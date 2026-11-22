import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { captureJobFailure } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { ATTENDANCE_RECORDED } from '@teachhub/modules/attendance';
import {
  AbsenceNotifier,
  type OutboxJobData,
} from '@teachhub/modules/notifications';
import { OUTBOX_QUEUE_URGENT } from '../outbox/outbox-policy.js';

/** Consumer hàng đợi `urgent` do outbox relay đẩy sang (S3-BE-04). Job idempotent theo `eventId`; ném lỗi để BullMQ thử lại. */
@Processor(OUTBOX_QUEUE_URGENT)
@Injectable()
export class UrgentProcessor extends WorkerHost {
  private readonly log = new Logger(UrgentProcessor.name);

  constructor(
    private readonly absence: AbsenceNotifier,
    private readonly tx: TxService,
  ) {
    super();
  }

  async process(job: Job<OutboxJobData>): Promise<void> {
    if (job.name === ATTENDANCE_RECORDED) return this.absence.handle(job.data);
    this.log.warn(`loại sự kiện khẩn chưa có xử lý: ${job.name}`);
  }

  /**
   * Lần thất bại CUỐI (hết `attempts`): log error chỉ với eventId + loại (không PII) và đánh dấu sự kiện outbox
   * (`failed_at`, `last_error`) để có chỗ tra. Các lần thất bại giữa chừng chỉ để BullMQ thử lại.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<OutboxJobData> | undefined,
    err: Error,
  ): Promise<void> {
    captureJobFailure(job, err);
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const eventId = job.data?.eventId;
    this.log.error(
      `sự kiện ${eventId ?? '?'} (${job.name}) hết lượt thử: ${err.name}`,
    );
    if (!eventId) return;
    try {
      await this.tx.run({ userId: null }, (t) =>
        t.execute(
          sql`update outbox_events set failed_at = now(), last_error = ${`consumer_exhausted: ${err.name}`} where id = ${eventId}`,
        ),
      );
    } catch (e) {
      this.log.error(
        `không đánh dấu được sự kiện ${eventId}: ${e instanceof Error ? e.name : 'lỗi'}`,
      );
    }
  }
}
