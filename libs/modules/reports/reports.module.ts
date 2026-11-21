import { Module } from '@nestjs/common';
import { ReportsController } from './http/reports.controller.js';

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
