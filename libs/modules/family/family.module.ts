import { Module } from '@nestjs/common';
import { FamilyService } from './application/family.service.js';
import { FamilyController } from './http/family.controller.js';

@Module({ controllers: [FamilyController], providers: [FamilyService] })
export class FamilyModule {}
