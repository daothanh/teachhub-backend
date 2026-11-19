import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
  uuidv7,
} from '@teachhub/core';
import { centerWaitlist } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import {
  type CenterWaitlistEntry,
  centerWaitlistEntrySchema,
  type CreateCenterWaitlistRequest,
  createCenterWaitlistRequestSchema,
} from './onboarding.schemas.js';

// Hợp đồng Sprint 2 (S1-CT-02); S2-BE-11. Mọi người dùng đã đăng nhập đều gọi được.
@ApiTags('center-waitlist')
@ApiBearerAuth('bearer')
@Controller('center-waitlist')
export class CenterWaitlistController {
  constructor(private readonly idem: Idempotency) {}

  // Form công khai theo nghĩa "ai đăng nhập cũng gọi được": chặn gửi hàng loạt theo IP.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  @ApiOperation({
    summary: 'Đăng ký sớm Chủ trung tâm (US-0.10 AC4)',
    description:
      'Gửi lặp cùng `Idempotency-Key` chỉ tạo một bản ghi. Tối đa 5 request/giờ/IP, vượt → 429 `RATE_LIMITED`.',
  })
  @ApiCreatedResponse({ standardSchema: centerWaitlistEntrySchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'RATE_LIMITED',
  )
  create(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createCenterWaitlistRequestSchema })
    body: CreateCenterWaitlistRequest,
  ): Promise<CenterWaitlistEntry> {
    return this.idem.run(req, reply, ctx, async (t) => {
      const [row] = await t
        .insert(centerWaitlist)
        .values({
          id: uuidv7(),
          userId: ctx.userId!,
          centerName: body.centerName,
          teacherCount: body.teacherCount,
        })
        .returning();
      return {
        status: 201,
        body: {
          id: row!.id,
          centerName: row!.centerName,
          teacherCount: row!.teacherCount,
          createdAt: row!.createdAt.toISOString(),
        },
      };
    });
  }
}
