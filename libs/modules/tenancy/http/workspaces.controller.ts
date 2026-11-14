import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';

export const createWorkspaceRequestSchema = z.object({});
export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;

export const workspaceCreatedSchema = z
  .object({ tenantId: z.uuid(), membershipId: z.uuid() })
  .meta({
    id: 'WorkspaceCreated',
    example: {
      tenantId: '019a8f3e-8a10-7e55-8c1d-0a1b2c3d4e5f',
      membershipId: '019a8f3e-8a10-7e55-8c1d-2b3c4d5e6f70',
    },
  });
export type WorkspaceCreated = z.infer<typeof workspaceCreatedSchema>;

// Hợp đồng Sprint 1 (S0-CT-01); thân hàm ở S1-BE-08.
@ApiTags('workspaces')
@ApiBearerAuth('bearer')
@Controller('workspaces')
export class WorkspacesController {
  @Post()
  @ApiOperation({
    summary: 'Tạo không gian Giáo viên (US-0.10 AC2)',
    description:
      'Một giao dịch: tenant loại giáo viên + chi nhánh mặc định + membership `tenant_owner` + gói Free. ' +
      'User đã có không gian Giáo viên → 200 với không gian sẵn có (US-0.1 AC4: không tạo tenant mới).',
  })
  @ApiCreatedResponse({ standardSchema: workspaceCreatedSchema })
  @ApiOkResponse({
    standardSchema: workspaceCreatedSchema,
    description: 'Đã có không gian Giáo viên',
  })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'UNAUTHENTICATED', 'TOKEN_EXPIRED')
  create(
    @Body({ schema: createWorkspaceRequestSchema })
    _body: CreateWorkspaceRequest,
  ): WorkspaceCreated {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
