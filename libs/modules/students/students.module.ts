import { Module } from '@nestjs/common';
import { PlanModule } from '@teachhub/modules/subscription';
import { StudentsService } from './application/students.service.js';
import { StudentsController } from './http/students.controller.js';

@Module({
  imports: [PlanModule],
  controllers: [StudentsController],
  providers: [StudentsService],
})
export class StudentsModule {}
