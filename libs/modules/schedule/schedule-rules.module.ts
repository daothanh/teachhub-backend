import { Module } from '@nestjs/common';
import { ScheduleRulesReader } from './application/schedule-rules.reader.js';

/** Phần đọc của module schedule cho module khác dùng; tách riêng để không kéo controller vào module phụ thuộc. */
@Module({ providers: [ScheduleRulesReader], exports: [ScheduleRulesReader] })
export class ScheduleRulesModule {}
