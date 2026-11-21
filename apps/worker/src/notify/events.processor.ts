import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  BILLING_DRAFTS_READY,
  INVOICE_ISSUED,
} from '@teachhub/modules/billing';
import {
  BillingReadyNotifier,
  InvoiceIssuedNotifier,
} from '@teachhub/modules/notifications';
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
 * Consumer duy nhất của hàng đợi `events` (một hàng đợi chỉ nên có một processor), phân loại theo tên sự kiện:
 * `billing_drafts_ready` (S5-BE-05) → thông báo + push giáo viên; `invoice_issued` (S5-BE-07) → thông báo + push + email phụ huynh; `schedule_changed` (S4-BE-07) → chỉ ghi log.
 * shortcut (schedule_changed): chưa tạo thông báo cho phụ huynh. Loại `schedule_changed` chưa có trong oneOf notification
 * của hợp đồng (Owner chưa chốt), nên chưa tạo dòng `notifications` và chưa gửi push. Khi chốt: lấy phụ huynh có
 * `guardians.user_id` của học viên đang học lớp `payload.classId`, tạo thông báo idempotent theo `eventId` như báo vắng.
 */
@Processor(OUTBOX_QUEUE_DEFAULT)
@Injectable()
export class EventsProcessor extends WorkerHost {
  private readonly log = new Logger(EventsProcessor.name);

  constructor(
    private readonly billingReady: BillingReadyNotifier,
    private readonly invoiceIssued: InvoiceIssuedNotifier,
  ) {
    super();
  }

  process(job: Job): Promise<void> {
    if (job.name === BILLING_DRAFTS_READY)
      return this.billingReady.handle(job.data);
    if (job.name === INVOICE_ISSUED) return this.invoiceIssued.handle(job.data);
    // Loại khác chưa có consumer: ném lỗi để job giữ lại ở hàng `failed`, không bị nuốt im lặng.
    if (job.name !== SCHEDULE_CHANGED) {
      return Promise.reject(new Error(`chưa có xử lý cho sự kiện ${job.name}`));
    }
    // Chỉ id và loại thay đổi, không log lý do (văn bản tự do của giáo viên).
    const { eventId, payload } = job.data as ScheduleChangedJob;
    this.log.log(
      `schedule_changed ${eventId}: ${payload.change} buổi ${payload.sessionId} (chưa gửi thông báo)`,
    );
    return Promise.resolve();
  }
}
