import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { BillingCloseJob } from './application/billing-close.job.js';

/** Phần không có controller của module billing cho `worker` dùng (job `billing.close`). */
@Module({
  imports: [JobsModule],
  providers: [BillingCloseJob],
  exports: [BillingCloseJob],
})
export class BillingJobsModule {}
