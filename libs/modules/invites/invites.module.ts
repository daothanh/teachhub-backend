import { Module } from '@nestjs/common';
import { InviteAcceptanceService } from './application/invite-acceptance.service.js';
import { InviteAttemptLimiter } from './application/invite-attempt-limiter.js';
import { InvitesService } from './application/invites.service.js';
import { InviteAcceptanceController } from './http/invite-acceptance.controller.js';
import { InvitesController } from './http/invites.controller.js';

@Module({
  controllers: [InvitesController, InviteAcceptanceController],
  providers: [InvitesService, InviteAcceptanceService, InviteAttemptLimiter],
})
export class InvitesModule {}
