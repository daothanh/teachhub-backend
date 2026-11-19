import { Module } from '@nestjs/common';
import { ClassesService } from './application/classes.service.js';
import { ClassesController } from './http/classes.controller.js';

@Module({ controllers: [ClassesController], providers: [ClassesService] })
export class ClassesModule {}
