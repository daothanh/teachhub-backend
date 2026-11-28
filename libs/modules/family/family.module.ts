import { Module } from '@nestjs/common';
import { AbsenceRequestsService } from './application/absence-requests.service.js';
import { FamilyService } from './application/family.service.js';
import { FamilyController } from './http/family.controller.js';

@Module({
  controllers: [FamilyController],
  providers: [FamilyService, AbsenceRequestsService],
})
export class FamilyModule {}
