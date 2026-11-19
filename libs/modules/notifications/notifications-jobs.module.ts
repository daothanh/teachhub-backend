import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { PurgeStaleDevicesJob } from './application/devices.service.js';

/** Phần không có controller của module notifications cho `worker` dùng (job nền, processor báo vắng). */
@Module({
  imports: [JobsModule],
  providers: [PurgeStaleDevicesJob],
  exports: [PurgeStaleDevicesJob],
})
export class NotificationsJobsModule {}
