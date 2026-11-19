import { Module } from '@nestjs/common';
import { OnboardingService } from './application/onboarding.service.js';
import { CenterWaitlistController } from './http/center-waitlist.controller.js';
import { OnboardingController } from './http/onboarding.controller.js';
import { PayoutAccountsController } from './http/payout-accounts.controller.js';
import { WorkspacesController } from './http/workspaces.controller.js';

@Module({
  controllers: [
    WorkspacesController,
    OnboardingController,
    CenterWaitlistController,
    PayoutAccountsController,
  ],
  providers: [OnboardingService],
})
export class TenancyModule {}
