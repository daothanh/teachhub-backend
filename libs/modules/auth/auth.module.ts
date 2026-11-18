import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './http/auth.controller.js';
import { JwksController } from './http/jwks.controller.js';
import { JwtAuthGuard } from './jwt/jwt-auth.guard.js';
import { JwtKeysService } from './jwt/jwt-keys.service.js';

@Module({
  controllers: [AuthController, JwksController],
  providers: [JwtKeysService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [JwtKeysService],
})
export class AuthModule {}
