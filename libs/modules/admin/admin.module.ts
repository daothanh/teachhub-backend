import { Module } from '@nestjs/common';
import { AdminController } from './http/admin.controller.js';

@Module({ controllers: [AdminController] })
export class AdminModule {}
