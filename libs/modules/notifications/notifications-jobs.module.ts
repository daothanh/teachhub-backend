import { Module } from '@nestjs/common';
import { JobsModule, PushModule } from '@teachhub/infra';
import { AbsenceNotifier } from './application/absence-notifier.service.js';
import { PurgeStaleDevicesJob } from './application/devices.service.js';

/** Phần không có controller của module notifications cho `worker` dùng (job nền, báo vắng). */
@Module({
  imports: [JobsModule, PushModule],
  providers: [PurgeStaleDevicesJob, AbsenceNotifier],
  exports: [PurgeStaleDevicesJob, AbsenceNotifier],
})
export class NotificationsJobsModule {}
