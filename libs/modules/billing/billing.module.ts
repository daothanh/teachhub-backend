import { Module } from '@nestjs/common';
import { BillingService } from './application/billing.service.js';
import { BillingController } from './http/billing.controller.js';
import { FamilyInvoicesController } from './http/family-invoices.controller.js';

@Module({
  controllers: [BillingController, FamilyInvoicesController],
  providers: [BillingService],
})
export class BillingModule {}
