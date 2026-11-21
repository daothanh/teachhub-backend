import { Module } from '@nestjs/common';
import { PlanService } from './application/plan.service.js';

/** Nguồn sự thật về gói/giới hạn, không có controller: classes, students import để kiểm hạn mức (US-0.7). */
@Module({ providers: [PlanService], exports: [PlanService] })
export class PlanModule {}
