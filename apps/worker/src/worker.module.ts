import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreModule, type Env } from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import { JobsModule, RedisModule } from '@teachhub/infra';
import { ScheduleRulesModule } from '@teachhub/modules/schedule';
import { CRON_QUEUE, CronProcessor } from './cron.processor.js';

// Processor đầu tiên: `cron` (S2-BE-09). Outbox relay, notify, billing… thêm từ Sprint 3.
@Module({
  imports: [
    CoreModule,
    DbModule.register('WORKER_DATABASE_URL'),
    RedisModule,
    JobsModule,
    ScheduleRulesModule,
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
  ],
  providers: [CronProcessor],
})
export class WorkerModule {}
