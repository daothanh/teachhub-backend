import { Module } from '@nestjs/common';
import { StudentsController } from './http/students.controller.js';

@Module({ controllers: [StudentsController] })
export class StudentsModule {}
