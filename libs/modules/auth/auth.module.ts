import { Module } from '@nestjs/common';
import { AuthController } from './http/auth.controller.js';

@Module({ controllers: [AuthController] })
export class AuthModule {}
