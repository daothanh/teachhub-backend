import { Module } from '@nestjs/common';
import { InviteAcceptanceController } from './http/invite-acceptance.controller.js';
import { InvitesController } from './http/invites.controller.js';

@Module({ controllers: [InvitesController, InviteAcceptanceController] })
export class InvitesModule {}
