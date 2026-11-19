import { Module } from '@nestjs/common';
import { FamilyController } from './http/family.controller.js';

@Module({ controllers: [FamilyController] })
export class FamilyModule {}
