import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { SubscriptionLifecycleJob } from './application/lifecycle.job.js';

/** Phần không có controller của module subscription cho `worker` dùng (job `subscription.lifecycle`). */
@Module({
  imports: [JobsModule],
  providers: [SubscriptionLifecycleJob],
  exports: [SubscriptionLifecycleJob],
})
export class SubscriptionJobsModule {}
