import { Module } from '@nestjs/common';
import { ScheduleController } from './http/schedule.controller.js';

@Module({ controllers: [ScheduleController] })
export class ScheduleModule {}
