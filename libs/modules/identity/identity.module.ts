import { Global, Module } from '@nestjs/common';
import { MeController } from './http/me.controller.js';
import { MembershipCache } from './membership-cache.service.js';

// Global: MembershipGuard (@RequiresRole) chạy trong module nghiệp vụ nào cũng cần MembershipCache.
@Global()
@Module({
  controllers: [MeController],
  providers: [MembershipCache],
  exports: [MembershipCache],
})
export class IdentityModule {}
