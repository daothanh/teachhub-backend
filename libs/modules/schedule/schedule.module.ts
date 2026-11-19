import { Module } from '@nestjs/common';
import { ScheduleService } from './application/schedule.service.js';
import { ScheduleController } from './http/schedule.controller.js';
import { ScheduleRulesModule } from './schedule-rules.module.js';

@Module({
  imports: [ScheduleRulesModule],
  controllers: [ScheduleController],
  providers: [ScheduleService],
})
export class ScheduleModule {}
