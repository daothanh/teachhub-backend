import { Module } from '@nestjs/common';
import { FamilyInvoicesService } from './application/family-invoices.service.js';
import { BillingService } from './application/billing.service.js';
import { BillingController } from './http/billing.controller.js';
import { FamilyInvoicesController } from './http/family-invoices.controller.js';

@Module({
  controllers: [BillingController, FamilyInvoicesController],
  providers: [BillingService, FamilyInvoicesService],
})
export class BillingModule {}
