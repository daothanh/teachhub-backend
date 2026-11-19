import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@teachhub/core';
import { OUTBOX_QUEUE_DEFAULT, OUTBOX_QUEUE_URGENT } from './outbox-policy.js';
import { OutboxCleanupService } from './outbox-cleanup.service.js';
import { OutboxRelayService } from './outbox-relay.service.js';

// Hàng đợi chỉ dùng để `add` (producer): kết nối riêng, `enableOfflineQueue: false` để Redis đứt thì lỗi ngay
// thay vì xếp lệnh chờ trong bộ nhớ tới timeout. Consumer (Worker) tự mở kết nối khác nên không bị ảnh hưởng.
const producerQueue = (name: string) => ({
  name,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ({
    connection: {
      url: config.get('REDIS_URL'),
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    },
  }),
});

@Module({
  imports: [
    BullModule.registerQueueAsync(
      producerQueue(OUTBOX_QUEUE_URGENT),
      producerQueue(OUTBOX_QUEUE_DEFAULT),
    ),
  ],
  providers: [OutboxRelayService, OutboxCleanupService],
  exports: [OutboxRelayService, OutboxCleanupService],
})
export class OutboxModule {}
