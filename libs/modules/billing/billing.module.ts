import { Module } from '@nestjs/common';
import { BillingController } from './http/billing.controller.js';
import { FamilyInvoicesController } from './http/family-invoices.controller.js';

@Module({ controllers: [BillingController, FamilyInvoicesController] })
export class BillingModule {}
