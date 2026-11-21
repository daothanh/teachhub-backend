import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { BillingCloseJob } from './application/billing-close.job.js';
import { DunningService } from './application/dunning.service.js';
import { DunningJob } from './application/dunning.job.js';

/** Phần không có controller của module billing cho `worker` dùng (job `billing.close`, `billing.dunning`). */
@Module({
  imports: [JobsModule],
  providers: [BillingCloseJob, DunningJob, DunningService],
  exports: [BillingCloseJob, DunningJob],
})
export class BillingJobsModule {}
