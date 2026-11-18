import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import {
  CoreModule,
  GlobalExceptionFilter,
  validationPipe,
} from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import {
  MailerModule,
  ObjectStorageModule,
  RedisModule,
} from '@teachhub/infra';
import { AuthModule } from '@teachhub/modules/auth';
import { IdentityModule } from '@teachhub/modules/identity';
import { TenancyModule } from '@teachhub/modules/tenancy';
import { AppConfigController } from './app-config/app-config.controller.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    CoreModule,
    DbModule.register('DATABASE_URL'),
    RedisModule,
    ObjectStorageModule,
    MailerModule,
    AuthModule,
    IdentityModule,
    TenancyModule,
  ],
  controllers: [AppConfigController, HealthController],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class ApiModule {}
