import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
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

  constructor(private readonly absence: AbsenceNotifier) {
    super();
  }

  async process(job: Job<OutboxJobData>): Promise<void> {
    if (job.name === ATTENDANCE_RECORDED) return this.absence.handle(job.data);
    this.log.warn(`loại sự kiện khẩn chưa có xử lý: ${job.name}`);
  }
}
