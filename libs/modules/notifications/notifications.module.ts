import { Module } from '@nestjs/common';
import { DevicesService } from './application/devices.service.js';
import { NotificationsController } from './http/notifications.controller.js';
import { PushController } from './http/push.controller.js';

@Module({
  controllers: [NotificationsController, PushController],
  providers: [DevicesService],
})
export class NotificationsModule {}
