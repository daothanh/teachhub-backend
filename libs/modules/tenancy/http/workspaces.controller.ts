import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
  uuidv7,
} from '@teachhub/core';
import { Idempotency } from '@teachhub/infra';
import { MembershipCache } from '@teachhub/modules/identity';

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

@ApiTags('workspaces')
@ApiBearerAuth('bearer')
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly idem: Idempotency,
    private readonly cache: MembershipCache,
  ) {}

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
  async create(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createWorkspaceRequestSchema })
    _body: CreateWorkspaceRequest,
  ): Promise<WorkspaceCreated> {
    const result = await this.idem.run(req, reply, ctx, async (t) => {
      const { rows } = await t.execute<{
        tenant_id: string;
        membership_id: string;
        created: boolean;
      }>(
        sql`select * from app_private.create_teacher_workspace(${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()})`,
      );
      const r = rows[0]!;
      return {
        status: r.created ? 201 : 200,
        body: { tenantId: r.tenant_id, membershipId: r.membership_id },
      };
    });
    // Vai trò Giáo viên có hiệu lực ngay với token đang dùng (S1-BE-07b).
    await this.cache.invalidate(ctx.userId!);
    return result;
  }
}
