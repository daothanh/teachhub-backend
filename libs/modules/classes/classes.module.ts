import { Module } from '@nestjs/common';
import { ScheduleRulesModule } from '@teachhub/modules/schedule';
import { ClassesService } from './application/classes.service.js';
import { EnrollmentsService } from './application/enrollments.service.js';
import { ClassesController } from './http/classes.controller.js';
import { EnrollmentFeesController } from './http/enrollment-fees.controller.js';

@Module({
  imports: [ScheduleRulesModule],
  controllers: [ClassesController, EnrollmentFeesController],
  providers: [ClassesService, EnrollmentsService],
})
export class ClassesModule {}
