import { Module } from '@nestjs/common';
import { BillingModule } from '@teachhub/modules/billing';
import { PlanModule } from '@teachhub/modules/subscription';
import { ReportsService } from './application/reports.service.js';
import { ExportsController } from './http/exports.controller.js';
import { ReportsController } from './http/reports.controller.js';

@Module({
  imports: [BillingModule, PlanModule],
  controllers: [ReportsController, ExportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
