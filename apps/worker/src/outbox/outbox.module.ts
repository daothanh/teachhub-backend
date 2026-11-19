import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { OUTBOX_QUEUE_DEFAULT, OUTBOX_QUEUE_URGENT } from './outbox-policy.js';
import { OutboxCleanupService } from './outbox-cleanup.service.js';
import { OutboxRelayService } from './outbox-relay.service.js';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: OUTBOX_QUEUE_URGENT },
      { name: OUTBOX_QUEUE_DEFAULT },
    ),
  ],
  providers: [OutboxRelayService, OutboxCleanupService],
  exports: [OutboxRelayService, OutboxCleanupService],
})
export class OutboxModule {}
