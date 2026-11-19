import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreModule, type Env } from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import { JobsModule, RedisModule } from '@teachhub/infra';
import { NotificationsJobsModule } from '@teachhub/modules/notifications';
import { ScheduleRulesModule } from '@teachhub/modules/schedule';
import { CRON_QUEUE, CronProcessor } from './cron.processor.js';
import {
  OUTBOX_QUEUE_DEFAULT,
  OUTBOX_QUEUE_URGENT,
} from './outbox/outbox-policy.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { ScheduleChangedProcessor } from './notify/schedule-changed.processor.js';
import { UrgentProcessor } from './notify/urgent.processor.js';

// Processor: `cron` (S2-BE-09), outbox relay (S3-BE-04). Notify, billing… thêm theo từng module.
@Module({
  imports: [
    CoreModule,
    DbModule.register('WORKER_DATABASE_URL'),
    RedisModule,
    JobsModule,
    ScheduleRulesModule,
    NotificationsJobsModule,
    BullModule.registerQueue(
      { name: CRON_QUEUE },
      { name: OUTBOX_QUEUE_URGENT },
      { name: OUTBOX_QUEUE_DEFAULT },
    ),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          url: config.get('REDIS_URL'),
          maxRetriesPerRequest: null,
        },
      }),
    }),
    OutboxModule,
  ],
  providers: [CronProcessor, UrgentProcessor, ScheduleChangedProcessor],
})
export class WorkerModule {}
