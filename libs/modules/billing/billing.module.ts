import { Module } from '@nestjs/common';
import { FamilyInvoicesService } from './application/family-invoices.service.js';
import { DunningService } from './application/dunning.service.js';
import { PaymentsService } from './application/payments.service.js';
import { ReceivablesService } from './application/receivables.service.js';
import { BillingService } from './application/billing.service.js';
import { BillingController } from './http/billing.controller.js';
import { DunningController } from './http/dunning.controller.js';
import { FamilyInvoicesController } from './http/family-invoices.controller.js';
import { PaymentsController } from './http/payments.controller.js';
import { ReceivablesController } from './http/receivables.controller.js';

@Module({
  controllers: [
    BillingController,
    FamilyInvoicesController,
    PaymentsController,
    DunningController,
    ReceivablesController,
  ],
  providers: [
    BillingService,
    DunningService,
    FamilyInvoicesService,
    PaymentsService,
    ReceivablesService,
  ],
  exports: [ReceivablesService],
})
export class BillingModule {}
