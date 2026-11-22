import { Module } from '@nestjs/common';
import { FilesController } from './http/files.controller.js';

@Module({ controllers: [FilesController] })
export class FilesModule {}
