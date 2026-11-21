import { Module } from '@nestjs/common';
import { StudentsService } from './application/students.service.js';
import { StudentsController } from './http/students.controller.js';

@Module({ controllers: [StudentsController], providers: [StudentsService] })
export class StudentsModule {}
