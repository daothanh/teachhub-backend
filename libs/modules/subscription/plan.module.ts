import { Module } from '@nestjs/common';
import { PlanService } from './application/plan.service.js';
import { FeatureGuard } from './http/feature.guard.js';

/** Nguồn sự thật về gói/giới hạn, không có controller: classes, students import để kiểm hạn mức (US-0.7); module có route Pro import để dùng `@RequiresFeature`. */
@Module({
  providers: [PlanService, FeatureGuard],
  exports: [PlanService, FeatureGuard],
})
export class PlanModule {}
