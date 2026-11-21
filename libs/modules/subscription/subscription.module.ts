import { Module } from '@nestjs/common';
import { PlanModule } from './plan.module.js';
import { RevenueCatService } from './application/revenuecat.service.js';
import { SubscriptionService } from './application/subscription.service.js';
import { RevenueCatWebhookController } from './http/revenuecat-webhook.controller.js';
import { RevenueCatSecretGuard } from './http/revenuecat-secret.guard.js';
import { SubscriptionController } from './http/subscription.controller.js';

@Module({
  imports: [PlanModule],
  controllers: [SubscriptionController, RevenueCatWebhookController],
  providers: [SubscriptionService, RevenueCatService, RevenueCatSecretGuard],
})
export class SubscriptionModule {}
