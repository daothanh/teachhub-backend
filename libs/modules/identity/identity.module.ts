import { Global, Module } from '@nestjs/common';
import { ConsentsService } from './application/consents.service.js';
import { ConsentsController } from './http/consents.controller.js';
import { MeController } from './http/me.controller.js';
import { MembershipCache } from './membership-cache.service.js';

// Global: MembershipGuard (@RequiresRole) chạy trong module nghiệp vụ nào cũng cần MembershipCache.
@Global()
@Module({
  controllers: [MeController, ConsentsController],
  providers: [MembershipCache, ConsentsService],
  exports: [MembershipCache, ConsentsService],
})
export class IdentityModule {}
