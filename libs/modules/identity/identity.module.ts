import { Module } from '@nestjs/common';
import { MeController } from './http/me.controller.js';

@Module({ controllers: [MeController] })
export class IdentityModule {}
