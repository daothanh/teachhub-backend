import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { InvitesService } from '../application/invites.service.js';
import {
  type CreateInviteRequest,
  createInviteRequestSchema,
  type Invite,
  type InviteCreated,
  inviteCreatedSchema,
  type InviteList,
  inviteListSchema,
  inviteSchema,
} from './invites.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 4 (S3-FL-12); S4-BE-03. Token và mã ngắn chỉ có trong phản hồi tạo/gửi lại.
@ApiTags('invites')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class InvitesController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly invites: InvitesService,
  ) {}

  @Post('students/:id/invites')
  @ApiOperation({
    summary: 'Tạo lời mời phụ huynh: link + mã ngắn (US-1.6 AC2, AC3)',
    description:
      'Sinh `token` (lưu băm SHA-256) và `shortCode` 8 ký tự (duy nhất khi còn hiệu lực), hết hạn sau 7 ngày. ' +
      'Phụ huynh đã có lời mời còn hiệu lực → lời mời cũ bị vô hiệu (`revoked`), link cũ chết ngay. Phụ huynh đã kích hoạt → 409 `CONFLICT_STALE`. ' +
      '`token` và `shortCode` chỉ có trong phản hồi này; các endpoint đọc không bao giờ trả chúng. Phát lại cùng `Idempotency-Key` trả lại phản hồi đã lưu, nên với route này phản hồi lưu phải mã hóa khi nghỉ và TTL ngắn (≤ 10 phút), hết TTL thì tạo lại bằng khóa mới. Học viên/phụ huynh của tenant khác → 404.',
  })
  @ApiCreatedResponse({ standardSchema: inviteCreatedSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
  create(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) studentId: string,
    @Body({ schema: createInviteRequestSchema }) body: CreateInviteRequest,
  ): Promise<InviteCreated> {
    return this.idem.run(
      req,
      reply,
      ctx,
      async (t) => ({
        status: 201,
        body: await this.invites.create(
          t,
          { tenantId: ctx.tenantId!, userId: ctx.userId! },
          studentId,
          body.guardianId,
        ),
      }),
      // Phản hồi có token và mã: lưu mã hóa, phát lại tối đa 10 phút.
      { sensitive: true },
    );
  }

  @Get('students/:id/invites')
  @ApiOperation({
    summary: 'Trạng thái lời mời của học viên (US-1.6 AC4)',
    description:
      'Lời mời mới nhất của từng phụ huynh. Chỉ trạng thái và mốc thời gian; không có `token` hay `shortCode`. Trạng thái `expired` được tính theo `expiresAt` lúc đọc. ' +
      '`acceptedBy` cho giáo viên biết ai đã nhận. Rủi ro chấp nhận ở MVP: link bị chuyển tiếp thì người lạ có thể nhận nhầm; giáo viên phát hiện qua `acceptedBy` rồi gỡ liên kết bằng cách bỏ phụ huynh khỏi `guardians` của `PATCH /students/{id}`, và người đó mất quyền xem `/family/**` ngay lập tức (không chờ hết cache).',
  })
  @ApiOkResponse({ standardSchema: inviteListSchema })
  @ApiErrors('NOT_FOUND')
  list(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) studentId: string,
  ): Promise<InviteList> {
    return this.tx.run(ctx, (t) =>
      this.invites.list(t, ctx.tenantId!, studentId),
    );
  }

  @Post('invites/:id/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Thu hồi lời mời (US-1.6)',
    description:
      'Link và mã ngắn dùng được ngay sau đó trở thành không hợp lệ. Idempotent: đã thu hồi thì trả lời mời hiện tại. Lời mời đã dùng (`used`) → 409 `CONFLICT_STALE`, muốn gỡ phụ huynh thì sửa `guardians` của học viên.',
  })
  @ApiOkResponse({ standardSchema: inviteSchema })
  @ApiIdempotencyKey()
  @ApiErrors('NOT_FOUND', 'CONFLICT_STALE')
  revoke(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<Invite> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.invites.revoke(t, ctx.tenantId!, id),
    }));
  }

  @Post('invites/:id/resend')
  @ApiOperation({
    summary:
      'Gửi lại: cấp link và mã mới cho lời mời hết hạn hoặc bị thu hồi (US-1.6 AC4)',
    description:
      'Tạo lời mời mới cho cùng học viên và phụ huynh (7 ngày), vô hiệu lời mời `pending` cũ nếu còn. Phản hồi như `POST /students/{id}/invites`, `token` và `shortCode` chỉ xuất hiện ở đây; phản hồi lưu cho `Idempotency-Key` phải mã hóa, TTL ≤ 10 phút. ' +
      'Phụ huynh đã kích hoạt (`used`) → 409 `CONFLICT_STALE`.',
  })
  @ApiCreatedResponse({ standardSchema: inviteCreatedSchema })
  @ApiIdempotencyKey()
  @ApiErrors('NOT_FOUND', 'CONFLICT_STALE')
  resend(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<InviteCreated> {
    return this.idem.run(
      req,
      reply,
      ctx,
      async (t) => ({
        status: 201,
        body: await this.invites.resend(
          t,
          { tenantId: ctx.tenantId!, userId: ctx.userId! },
          id,
        ),
      }),
      { sensitive: true },
    );
  }
}
