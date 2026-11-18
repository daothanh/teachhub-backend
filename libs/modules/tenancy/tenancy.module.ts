import { Module } from '@nestjs/common';
import { WorkspacesController } from './http/workspaces.controller.js';

@Module({ controllers: [WorkspacesController] })
export class TenancyModule {}
