import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreModule, type Env } from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import { RedisModule } from '@teachhub/infra';
import { OutboxModule } from './outbox/outbox.module.js';

// Processor (notify, billing…) và job scheduler (schedulers.ts) thêm theo từng module từ Sprint 3.
@Module({
  imports: [
    CoreModule,
    DbModule.register('WORKER_DATABASE_URL'),
    RedisModule,
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
})
export class WorkerModule {}
