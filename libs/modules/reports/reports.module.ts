import { Module } from '@nestjs/common';
import { BillingModule } from '@teachhub/modules/billing';
import { ReportsService } from './application/reports.service.js';
import { ReportsController } from './http/reports.controller.js';

@Module({
  imports: [BillingModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
