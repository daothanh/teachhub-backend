import { Module } from '@nestjs/common';
import { FilesService } from './application/files.service.js';
import { FilesController } from './http/files.controller.js';

@Module({ controllers: [FilesController], providers: [FilesService] })
export class FilesModule {}
