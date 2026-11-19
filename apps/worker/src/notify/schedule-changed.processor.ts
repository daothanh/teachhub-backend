import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  SCHEDULE_CHANGED,
  type ScheduleChangedPayload,
} from '@teachhub/modules/schedule';
import { OUTBOX_QUEUE_DEFAULT } from '../outbox/outbox-policy.js';

interface ScheduleChangedJob {
  eventId: string;
  tenantId: string;
  payload: ScheduleChangedPayload;
}

/**
 * Consumer hàng đợi `events` cho `schedule_changed` (S4-BE-07).
 * shortcut: chỉ ghi log, chưa tạo thông báo cho phụ huynh. Loại `schedule_changed` chưa có trong oneOf notification
 * của hợp đồng (Owner chưa chốt), nên chưa tạo dòng `notifications` và chưa gửi push. Khi chốt: lấy phụ huynh có
 * `guardians.user_id` của học viên đang học lớp `payload.classId`, tạo thông báo idempotent theo `eventId` như báo vắng.
 */
@Processor(OUTBOX_QUEUE_DEFAULT)
@Injectable()
export class ScheduleChangedProcessor extends WorkerHost {
  private readonly log = new Logger(ScheduleChangedProcessor.name);

  process(job: Job<ScheduleChangedJob>): Promise<void> {
    // Loại khác chưa có consumer: ném lỗi để job giữ lại ở hàng `failed`, không bị nuốt im lặng.
    if (job.name !== SCHEDULE_CHANGED) {
      return Promise.reject(new Error(`chưa có xử lý cho sự kiện ${job.name}`));
    }
    // Chỉ id và loại thay đổi, không log lý do (văn bản tự do của giáo viên).
    this.log.log(
      `schedule_changed ${job.data.eventId}: ${job.data.payload.change} buổi ${job.data.payload.sessionId} (chưa gửi thông báo)`,
    );
    return Promise.resolve();
  }
}
