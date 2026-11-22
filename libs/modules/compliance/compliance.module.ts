import { Module } from '@nestjs/common';
import { PlanModule } from '@teachhub/modules/subscription';
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
})
export class ComplianceModule {}
