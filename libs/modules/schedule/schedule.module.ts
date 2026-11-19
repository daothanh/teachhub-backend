import { Module } from '@nestjs/common';
import { SessionChangesService } from './application/session-changes.service.js';
import { ScheduleController } from './http/schedule.controller.js';
import { ScheduleRulesModule } from './schedule-rules.module.js';

@Module({
  imports: [ScheduleRulesModule],
  controllers: [ScheduleController],
  providers: [SessionChangesService],
})
export class ScheduleModule {}
