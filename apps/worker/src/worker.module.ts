import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreModule, type Env } from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import { JobsModule, RedisModule } from '@teachhub/infra';
import { NotificationsJobsModule } from '@teachhub/modules/notifications';
import { ScheduleRulesModule } from '@teachhub/modules/schedule';
import { CRON_QUEUE, CronProcessor } from './cron.processor.js';
import { OutboxModule } from './outbox/outbox.module.js';

// Processor: `cron` (S2-BE-09), outbox relay (S3-BE-04). Notify, billing… thêm theo từng module.
@Module({
  imports: [
    CoreModule,
    DbModule.register('WORKER_DATABASE_URL'),
    RedisModule,
    JobsModule,
    ScheduleRulesModule,
    NotificationsJobsModule,
    BullModule.registerQueue({ name: CRON_QUEUE }),
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
  providers: [CronProcessor],
})
export class WorkerModule {}
