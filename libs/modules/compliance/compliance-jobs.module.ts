import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { TaxThresholdJob } from './application/tax-threshold.job.js';
import { TaxThresholdService } from './application/tax-threshold.service.js';

/** Phần không có controller của module compliance cho `worker` dùng (job `compliance.tax-threshold`). */
@Module({
  imports: [JobsModule],
  providers: [TaxThresholdJob, TaxThresholdService],
  exports: [TaxThresholdJob],
})
export class ComplianceJobsModule {}
