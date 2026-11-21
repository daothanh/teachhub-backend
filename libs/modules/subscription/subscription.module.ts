import { Module } from '@nestjs/common';
import { RevenueCatWebhookController } from './http/revenuecat-webhook.controller.js';
import { SubscriptionController } from './http/subscription.controller.js';

@Module({ controllers: [SubscriptionController, RevenueCatWebhookController] })
export class SubscriptionModule {}
