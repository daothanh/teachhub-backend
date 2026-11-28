import { Module } from '@nestjs/common';
import { DevicesService } from './application/devices.service.js';
import { QuietHoursService } from './application/quiet-hours.service.js';
import { NotificationsService } from './application/notifications.service.js';
import { NotificationsController } from './http/notifications.controller.js';
import { WebPushController } from './http/web-push.controller.js';
import { QuietHoursController } from './http/quiet-hours.controller.js';
import { PushController } from './http/push.controller.js';

@Module({
  controllers: [
    NotificationsController,
    PushController,
    WebPushController,
    QuietHoursController,
  ],
  providers: [DevicesService, NotificationsService, QuietHoursService],
})
export class NotificationsModule {}
