import { Module } from '@nestjs/common';
import { AuthModule } from '@teachhub/modules/auth';
import { OnboardingService } from './application/onboarding.service.js';
import { PayoutAccountsService } from './application/payout-accounts.service.js';
import { CenterWaitlistController } from './http/center-waitlist.controller.js';
import { OnboardingController } from './http/onboarding.controller.js';
import { PayoutAccountsController } from './http/payout-accounts.controller.js';
import { WorkspacesController } from './http/workspaces.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [
    WorkspacesController,
    OnboardingController,
    CenterWaitlistController,
    PayoutAccountsController,
  ],
  providers: [OnboardingService, PayoutAccountsService],
})
export class TenancyModule {}
