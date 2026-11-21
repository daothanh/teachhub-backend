import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { BillingCloseJob } from './application/billing-close.job.js';
import { BillingReconcileJob } from './application/billing-reconcile.job.js';

/** Phần không có controller của module billing cho `worker` dùng (job `billing.close`, `billing.reconcile`). */
@Module({
  imports: [JobsModule],
  providers: [BillingCloseJob, BillingReconcileJob],
  exports: [BillingCloseJob, BillingReconcileJob],
})
export class BillingJobsModule {}
