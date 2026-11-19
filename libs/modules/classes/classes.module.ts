import { Module } from '@nestjs/common';
import { ClassesController } from './http/classes.controller.js';

@Module({ controllers: [ClassesController] })
export class ClassesModule {}
