import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import {
  CoreModule,
  GlobalExceptionFilter,
  validationPipe,
} from '@teachhub/core';
import { DbModule } from '@teachhub/db';
import {
  IdempotencyModule,
  MailerModule,
  ObjectStorageModule,
  RedisModule,
  ThrottleModule,
} from '@teachhub/infra';
import { AdminModule } from '@teachhub/modules/admin';
import { AttendanceModule } from '@teachhub/modules/attendance';
import { AuthModule } from '@teachhub/modules/auth';
import { ClassesModule } from '@teachhub/modules/classes';
import { IdentityModule } from '@teachhub/modules/identity';
import { NotificationsModule } from '@teachhub/modules/notifications';
import { ScheduleModule } from '@teachhub/modules/schedule';
import { StudentsModule } from '@teachhub/modules/students';
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
    IdempotencyModule,
    ThrottleModule,
    AuthModule,
    IdentityModule,
    TenancyModule,
    ClassesModule,
    StudentsModule,
    ScheduleModule,
    AdminModule,
    AttendanceModule,
    NotificationsModule,
  ],
  controllers: [AppConfigController, HealthController],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class ApiModule {}
