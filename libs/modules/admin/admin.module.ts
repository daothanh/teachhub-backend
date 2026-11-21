import { Module } from '@nestjs/common';
import { BankTransferAdminService } from './application/bank-transfer-admin.service.js';
import { AdminController } from './http/admin.controller.js';
import { AdminGuard } from './http/admin.guard.js';

@Module({
  controllers: [AdminController],
  providers: [AdminGuard, BankTransferAdminService],
})
export class AdminModule {}
