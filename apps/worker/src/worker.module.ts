import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreModule, type Env } from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import { JobsModule, ObjectStorageModule, RedisModule } from '@teachhub/infra';
import { BillingJobsModule } from '@teachhub/modules/billing';
import { FilesJobsModule } from '@teachhub/modules/files';
import { NotificationsJobsModule } from '@teachhub/modules/notifications';
import { SubscriptionJobsModule } from '@teachhub/modules/subscription';
import { ScheduleRulesModule } from '@teachhub/modules/schedule';
import { CRON_QUEUE, CronProcessor } from './cron.processor.js';
import {
  OUTBOX_QUEUE_DEFAULT,
  OUTBOX_QUEUE_URGENT,
} from './outbox/outbox-policy.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { EventsProcessor } from './notify/events.processor.js';
import { UrgentProcessor } from './notify/urgent.processor.js';

// Processor: `cron` (S2-BE-09), outbox relay (S3-BE-04). Notify, billing… thêm theo từng module.
@Module({
  imports: [
    CoreModule,
    DbModule.register('WORKER_DATABASE_URL'),
    RedisModule,
    ObjectStorageModule,
    JobsModule,
    ScheduleRulesModule,
    BillingJobsModule,
    NotificationsJobsModule,
    SubscriptionJobsModule,
    FilesJobsModule,
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
  providers: [CronProcessor, UrgentProcessor, EventsProcessor],
})
export class WorkerModule {}
