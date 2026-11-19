import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { ScheduleRulesReader } from './application/schedule-rules.reader.js';
import { GenerateSessionsJob } from './application/generate-sessions.job.js';
import { ScheduleService } from './application/schedule.service.js';

/** Phần không có controller của module schedule cho module khác (classes, worker) dùng. */
@Module({
  imports: [JobsModule],
  providers: [ScheduleRulesReader, ScheduleService, GenerateSessionsJob],
  exports: [ScheduleRulesReader, ScheduleService, GenerateSessionsJob],
})
export class ScheduleRulesModule {}
