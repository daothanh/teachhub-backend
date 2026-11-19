import { Module } from '@nestjs/common';
import { AttendanceController } from './http/attendance.controller.js';

@Module({ controllers: [AttendanceController] })
export class AttendanceModule {}
