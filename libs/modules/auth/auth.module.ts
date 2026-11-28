import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './http/auth.controller.js';
import { JwksController } from './http/jwks.controller.js';
import { AppleAndroidService } from './apple/apple-android.service.js';
import { AppleIdTokenService } from './apple/apple-id-token.service.js';
import { GoogleIdTokenService } from './google/google-id-token.service.js';
import { JwtAuthGuard } from './jwt/jwt-auth.guard.js';
import { JwtKeysService } from './jwt/jwt-keys.service.js';
import { OtpService } from './otp/otp.service.js';
import { SessionService } from './session/session.service.js';

@Module({
  controllers: [AuthController, JwksController],
  providers: [
    JwtKeysService,
    OtpService,
    GoogleIdTokenService,
    AppleIdTokenService,
    AppleAndroidService,
    SessionService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [JwtKeysService, SessionService, OtpService],
})
export class AuthModule {}
