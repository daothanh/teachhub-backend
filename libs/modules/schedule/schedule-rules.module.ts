import { Module } from '@nestjs/common';
import { ScheduleRulesReader } from './application/schedule-rules.reader.js';
import { ScheduleService } from './application/schedule.service.js';

/** Phần không có controller của module schedule cho module khác (classes, worker) dùng. */
@Module({
  providers: [ScheduleRulesReader, ScheduleService],
  exports: [ScheduleRulesReader, ScheduleService],
})
export class ScheduleRulesModule {}
