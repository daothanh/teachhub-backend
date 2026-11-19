import { Module } from '@nestjs/common';
import { ScheduleController } from './http/schedule.controller.js';
import { ScheduleRulesModule } from './schedule-rules.module.js';

@Module({
  imports: [ScheduleRulesModule],
  controllers: [ScheduleController],
})
export class ScheduleModule {}
