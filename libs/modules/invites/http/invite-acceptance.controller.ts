import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  Public,
  type RequestContext,
} from '@teachhub/core';
import { Idempotency } from '@teachhub/infra';
import { InviteAcceptanceService } from '../application/invite-acceptance.service.js';
import {
  type InviteAccepted,
  inviteAcceptedSchema,
  type InvitePreview,
  invitePreviewSchema,
  type InviteTokenRequest,
  inviteTokenRequestSchema,
  type RedeemCodeRequest,
  redeemCodeRequestSchema,
} from './invites.schemas.js';

const header = (req: FastifyRequest) => {
  const v = req.headers['idempotency-key'];
  return typeof v === 'string' ? v : undefined;
};

// Hợp đồng Sprint 4 (S3-FL-12); S4-BE-04. Header `Cache-Control: no-store` và `Referrer-Policy: no-referrer` đặt ở hook `onSend` của app.ts cho cả ba route (kể cả lỗi). Không log token, mã mời hay body các route này.
// `@Throttle` chỉ đếm theo IP. Bộ đếm theo user, khóa 5 lần và bộ đếm toàn cục là bộ đếm riêng trong service (Redis).
@ApiTags('invites')
@Controller('invites')
export class InviteAcceptanceController {
  constructor(
    private readonly idem: Idempotency,
    private readonly acceptance: InviteAcceptanceService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Xem trước lời mời (công khai, US-0.3 AC1)',
    description:
      'Token ở body, không ở đường dẫn. Không cần đăng nhập. `@Throttle` 30 lần/phút theo IP → 429 `RATE_LIMITED`; ngoài ra service giữ bộ đếm theo IP (IPv6 gộp theo /64) và bộ đếm toàn cục. Chỉ trả tên giáo viên và tên gọi của trẻ. ' +
      'Token sai, sai định dạng, hết hạn, đã dùng hay bị thu hồi đều trả CÙNG 410 `INVITE_INVALID`, thân lỗi chuẩn không có thông tin giáo viên hay trẻ, nên không dò được lời mời. ' +
      'Response cần `Cache-Control: no-store`.',
  })
  @ApiOkResponse({ standardSchema: invitePreviewSchema })
  @ApiErrors('VALIDATION_FAILED', 'INVITE_INVALID', 'RATE_LIMITED')
  preview(
    @Req() req: FastifyRequest,
    @Body({ schema: inviteTokenRequestSchema }) body: InviteTokenRequest,
  ): Promise<InvitePreview> {
    return this.acceptance.preview(body.token, req.ip);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  @HttpCode(200)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Phụ huynh nhận lời mời bằng link (US-0.3)',
    description:
      'Cần đăng nhập (OTP/SSO). Chưa đồng ý điều khoản hiện hành → 403 `CONSENT_REQUIRED` kèm `details.termsVersion`; client gọi `POST /consents` rồi gọi lại. ' +
      'Kiểm tra đồng ý chạy TRƯỚC khi xét token nên người chưa đồng ý không biết token đúng hay sai. ' +
      'Thành công: tạo membership Phụ huynh nếu chưa có (gộp vào tài khoản có sẵn, US-0.4 AC1), ghi `guardians.user_id`, đánh dấu lời mời đã dùng. ' +
      'Token sai, hết hạn, đã dùng, bị thu hồi → CÙNG 410 `INVITE_INVALID`. ' +
      'Giới hạn: `@Throttle` 10 lần/phút theo IP; ngoài ra service đếm riêng theo user, theo IP (IPv6 theo /64) và toàn cục → 429 `RATE_LIMITED`.',
  })
  @ApiOkResponse({ standardSchema: inviteAcceptedSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'CONSENT_REQUIRED',
    'INVITE_INVALID',
    'RATE_LIMITED',
  )
  accept(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: inviteTokenRequestSchema }) body: InviteTokenRequest,
  ): Promise<InviteAccepted> {
    return this.acceptance.accept(
      {
        kind: 'token',
        secret: body.token,
        ctx,
        ip: req.ip,
        idempotencyKey: header(req),
      },
      (exec) =>
        this.idem.run(
          req,
          reply,
          ctx,
          async (t) => ({ status: 200, body: await exec(t) }),
          // Phản hồi có tên học viên (dữ liệu của trẻ): lưu mã hóa, phát lại tối đa 10 phút.
          { sensitive: true },
        ),
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('redeem-code')
  @HttpCode(200)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Phụ huynh nhận lời mời bằng mã ngắn (US-0.12 AC2, AC5)',
    description:
      'Cần đăng nhập. Cùng kết quả và cùng quy tắc đồng ý như `accept` (403 `CONSENT_REQUIRED` kiểm trước mã). Mã ngắn chỉ sống 48 giờ kể từ lúc tạo (token ở link sống 7 ngày). ' +
      '`@Throttle` chỉ là giới hạn thô 10 lần/phút theo IP. Khóa thật là bộ đếm riêng trong service: 5 lần nhập sai (410) trong 15 phút theo user → 429 `INVITE_CODE_LOCKED` kèm `details.retryAfterSec` và header `Retry-After`; cùng quy tắc đếm theo IP (IPv6 theo /64). Bộ đếm toàn cục (500 lần sai/15 phút) chặn dò phân tán nhưng khi vượt trần chỉ chặn user hoặc IP đã nhập sai ít nhất một lần trong cửa sổ; người chưa sai lần nào vẫn được thử. ' +
      'Lỗi 422 do sai định dạng và phát lại phản hồi 410 đã lưu (cùng `Idempotency-Key`) không tính vào bộ đếm. ' +
      'Mã sai, hết hạn, đã dùng, bị thu hồi → CÙNG 410 `INVITE_INVALID`. Không gian mã 32^8 (2^40) cộng TTL 48 giờ và ba lớp bộ đếm đủ cho MVP; nếu TL muốn dư an toàn thì nâng lên 10 ký tự, chỉ cần đổi `pattern` của `code` và `shortCode`.',
  })
  @ApiOkResponse({ standardSchema: inviteAcceptedSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'CONSENT_REQUIRED',
    'INVITE_INVALID',
    'INVITE_CODE_LOCKED',
    'RATE_LIMITED',
  )
  redeemCode(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: redeemCodeRequestSchema }) body: RedeemCodeRequest,
  ): Promise<InviteAccepted> {
    return this.acceptance.accept(
      {
        kind: 'code',
        secret: body.code,
        ctx,
        ip: req.ip,
        idempotencyKey: header(req),
      },
      (exec) =>
        this.idem.run(
          req,
          reply,
          ctx,
          async (t) => ({ status: 200, body: await exec(t) }),
          // Phản hồi có tên học viên (dữ liệu của trẻ): lưu mã hóa, phát lại tối đa 10 phút.
          { sensitive: true },
        ),
    );
  }
}
