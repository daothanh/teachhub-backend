import { Module } from '@nestjs/common';
import { CenterWaitlistController } from './http/center-waitlist.controller.js';
import { OnboardingController } from './http/onboarding.controller.js';
import { WorkspacesController } from './http/workspaces.controller.js';

@Module({
  controllers: [
    WorkspacesController,
    OnboardingController,
    CenterWaitlistController,
  ],
})
export class TenancyModule {}
