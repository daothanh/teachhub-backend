import { Module } from '@nestjs/common';
import { JobsModule, MailerModule, PushModule } from '@teachhub/infra';
import { AbsenceNotifier } from './application/absence-notifier.service.js';
import { BillingReadyNotifier } from './application/billing-ready-notifier.service.js';
import { InvoiceIssuedNotifier } from './application/invoice-issued-notifier.service.js';
import { PaymentRecordedNotifier } from './application/payment-recorded-notifier.service.js';
import { PaymentReminderNotifier } from './application/payment-reminder-notifier.service.js';
import { TaxThresholdNotifier } from './application/tax-threshold-notifier.service.js';
import { SubscriptionNotifier } from './application/subscription-notifier.service.js';
import { PurgeStaleDevicesJob } from './application/devices.service.js';

/** Phần không có controller của module notifications cho `worker` dùng (job nền, báo vắng). */
@Module({
  imports: [JobsModule, PushModule, MailerModule],
  providers: [
    PurgeStaleDevicesJob,
    AbsenceNotifier,
    BillingReadyNotifier,
    InvoiceIssuedNotifier,
    PaymentRecordedNotifier,
    PaymentReminderNotifier,
    SubscriptionNotifier,
    TaxThresholdNotifier,
  ],
  exports: [
    PurgeStaleDevicesJob,
    AbsenceNotifier,
    BillingReadyNotifier,
    InvoiceIssuedNotifier,
    PaymentRecordedNotifier,
    PaymentReminderNotifier,
    SubscriptionNotifier,
    TaxThresholdNotifier,
  ],
})
export class NotificationsJobsModule {}
