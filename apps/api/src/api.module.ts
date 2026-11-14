import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import {
  CoreModule,
  GlobalExceptionFilter,
  validationPipe,
} from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import { ObjectStorageModule, RedisModule } from '@teachhub/infra';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    CoreModule,
    DbModule.register('DATABASE_URL'),
    RedisModule,
    ObjectStorageModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class ApiModule {}
