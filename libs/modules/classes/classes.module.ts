import { Module } from '@nestjs/common';
import { ClassesService } from './application/classes.service.js';
import { EnrollmentsService } from './application/enrollments.service.js';
import { ClassesController } from './http/classes.controller.js';

@Module({
  controllers: [ClassesController],
  providers: [ClassesService, EnrollmentsService],
})
export class ClassesModule {}
