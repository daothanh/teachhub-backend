import { Module } from '@nestjs/common';
import { PlanModule } from '@teachhub/modules/subscription';
import { ChecklistService } from './application/checklist.service.js';
import { LegalArticlesService } from './application/legal-articles.service.js';
import { RevenueBookService } from './application/revenue-book.service.js';
import { TaxThresholdService } from './application/tax-threshold.service.js';
import { ComplianceController } from './http/compliance.controller.js';
import { LegalArticlesController } from './http/legal-articles.controller.js';
import { PublicDisclosureController } from './http/public-disclosure.controller.js';

@Module({
  imports: [PlanModule],
  controllers: [
    ComplianceController,
    PublicDisclosureController,
    LegalArticlesController,
  ],
  providers: [
    ChecklistService,
    RevenueBookService,
    TaxThresholdService,
    LegalArticlesService,
  ],
})
export class ComplianceModule {}
