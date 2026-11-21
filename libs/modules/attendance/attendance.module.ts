import { Module } from '@nestjs/common';
import { ScheduleRulesModule } from '@teachhub/modules/schedule';
import { AttendanceService } from './application/attendance.service.js';
import { AttendanceController } from './http/attendance.controller.js';

@Module({
  imports: [ScheduleRulesModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
})
export class AttendanceModule {}
