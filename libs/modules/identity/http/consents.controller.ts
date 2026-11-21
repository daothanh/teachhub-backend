import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { ConsentsService } from '../application/consents.service.js';
import {
  type Consent,
  type ConsentStatus,
  type ConsentStatusQuery,
  consentSchema,
  consentStatusQuerySchema,
  consentStatusSchema,
  type CreateConsentRequest,
  createConsentRequestSchema,
} from './consents.schemas.js';

// Hợp đồng Sprint 4 (S3-FL-12); bảng ở S4-BE-01, thân hàm ở S4-BE-05.
@ApiTags('consents')
@ApiBearerAuth('bearer')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
@Controller('consents')
export class ConsentsController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly consents: ConsentsService,
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @ApiOperation({
    summary: 'Ghi đồng ý xử lý dữ liệu theo vai trò (FR-0.14, US-0.3 AC2)',
    description:
      'Chỉ ghi thêm (bằng chứng pháp lý): mỗi lần gọi thêm một dòng (`role`, `termsVersion`, `acceptedAt` giờ server, `ip_hash` HMAC và user agent do server lấy từ request); không có sửa hay xóa, dòng cũ không bao giờ đổi. ' +
      'Chặn trùng: cùng user, `role`, `termsVersion` trong 60 giây thì không thêm dòng, trả lại dòng vừa ghi (vẫn 201) để retry và bấm đúp không nhân bản. Giới hạn 10 lần/phút theo IP → 429 `RATE_LIMITED`. ' +
      'Không cần đã có membership vai trò đó (phụ huynh mới đồng ý trước khi nhận lời mời). ' +
      '`termsVersion` khác bản hiện hành → 409 `CONFLICT_STALE`, client tải lại điều khoản qua `GET /consents/status`.',
  })
  @ApiCreatedResponse({ standardSchema: consentSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'CONFLICT_STALE', 'RATE_LIMITED')
  create(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createConsentRequestSchema }) body: CreateConsentRequest,
  ): Promise<Consent> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.consents.create(t, ctx.userId!, body, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    }));
  }

  @Get('status')
  @ApiOperation({
    summary: 'Điều khoản hiện hành và trạng thái đồng ý của tôi',
    description:
      'Bổ sung ngoài Spec §5.4: màn đồng ý cần biết phiên bản hiện hành, và guard "đã đồng ý" của shell (S4-FL-09) cần đọc trạng thái. Chỉ đọc dữ liệu của chính user.',
  })
  @ApiOkResponse({ standardSchema: consentStatusSchema })
  @ApiErrors('VALIDATION_FAILED')
  status(
    @Ctx() ctx: RequestContext,
    @Query({ schema: consentStatusQuerySchema }) query: ConsentStatusQuery,
  ): Promise<ConsentStatus> {
    return this.tx.run({ userId: ctx.userId }, (t) =>
      this.consents.status(t, ctx.userId!, query.role),
    );
  }
}
