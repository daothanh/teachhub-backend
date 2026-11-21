import { Module } from '@nestjs/common';
import { ScheduleRulesModule } from '@teachhub/modules/schedule';
import { PlanModule } from '@teachhub/modules/subscription';
import { ClassesService } from './application/classes.service.js';
import { EnrollmentsService } from './application/enrollments.service.js';
import { ClassesController } from './http/classes.controller.js';
import { EnrollmentFeesController } from './http/enrollment-fees.controller.js';

@Module({
  imports: [ScheduleRulesModule, PlanModule],
  controllers: [ClassesController, EnrollmentFeesController],
  providers: [ClassesService, EnrollmentsService],
})
export class ClassesModule {}
