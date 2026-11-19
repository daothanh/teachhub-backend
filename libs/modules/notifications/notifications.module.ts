import { Module } from '@nestjs/common';
import { NotificationsController } from './http/notifications.controller.js';
import { WebPushController } from './http/web-push.controller.js';
import { PushController } from './http/push.controller.js';

@Module({
  controllers: [NotificationsController, PushController, WebPushController],
})
export class NotificationsModule {}
