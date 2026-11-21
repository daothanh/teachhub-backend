import { Module } from '@nestjs/common';
import { JobsModule, MailerModule, PushModule } from '@teachhub/infra';
import { AbsenceNotifier } from './application/absence-notifier.service.js';
import { BillingReadyNotifier } from './application/billing-ready-notifier.service.js';
import { InvoiceIssuedNotifier } from './application/invoice-issued-notifier.service.js';
import { PurgeStaleDevicesJob } from './application/devices.service.js';

/** Phần không có controller của module notifications cho `worker` dùng (job nền, báo vắng). */
@Module({
  imports: [JobsModule, PushModule, MailerModule],
  providers: [
    PurgeStaleDevicesJob,
    AbsenceNotifier,
    BillingReadyNotifier,
    InvoiceIssuedNotifier,
  ],
  exports: [
    PurgeStaleDevicesJob,
    AbsenceNotifier,
    BillingReadyNotifier,
    InvoiceIssuedNotifier,
  ],
})
export class NotificationsJobsModule {}
