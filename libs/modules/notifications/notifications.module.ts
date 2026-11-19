import { Module } from '@nestjs/common';
import { NotificationsController } from './http/notifications.controller.js';
import { PushController } from './http/push.controller.js';

@Module({ controllers: [NotificationsController, PushController] })
export class NotificationsModule {}
