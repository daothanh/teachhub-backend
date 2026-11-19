import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Public,
} from '@teachhub/core';
import {
  type InviteAccepted,
  inviteAcceptedSchema,
  type InvitePreview,
  invitePreviewSchema,
  inviteTokenParam,
  type RedeemCodeRequest,
  redeemCodeRequestSchema,
} from './invites.schemas.js';

// Hợp đồng Sprint 4 (S3-FL-12); thân hàm ở S4-BE-04. Không log token, mã mời hay URL chứa token.
@ApiTags('invites')
@Controller('invites')
export class InviteAcceptanceController {
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token/preview')
  @ApiOperation({
    summary: 'Xem trước lời mời (công khai, US-0.3 AC1)',
    description:
      'Không cần đăng nhập. Giới hạn 30 lần/phút mỗi IP → 429 `RATE_LIMITED`. Chỉ trả tên giáo viên, tên con, lớp. ' +
      'Token sai, sai định dạng, hết hạn, đã dùng hay bị thu hồi đều trả CÙNG 410 `INVITE_INVALID`, không phân biệt lý do (không dò được lời mời).',
  })
  @ApiOkResponse({ standardSchema: invitePreviewSchema })
  @ApiErrors('INVITE_INVALID', 'RATE_LIMITED')
  preview(
    @Param('token', { schema: inviteTokenParam }) _token: string,
  ): InvitePreview {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/accept')
  @HttpCode(200)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Phụ huynh nhận lời mời bằng link (US-0.3)',
    description:
      'Cần đăng nhập (OTP/SSO). Chưa đồng ý điều khoản hiện hành → 403 `CONSENT_REQUIRED` kèm `details.termsVersion`; client gọi `POST /consents` rồi gọi lại. ' +
      'Kiểm tra đồng ý chạy TRƯỚC khi xét token nên người chưa đồng ý không biết token đúng hay sai. ' +
      'Thành công: tạo membership Phụ huynh nếu chưa có (gộp vào tài khoản có sẵn, US-0.4 AC1), ghi `guardians.user_id`, đánh dấu lời mời đã dùng. ' +
      'Token sai, hết hạn, đã dùng, bị thu hồi → CÙNG 410 `INVITE_INVALID`. Giới hạn 10 lần/phút mỗi IP và user → 429 `RATE_LIMITED`.',
  })
  @ApiOkResponse({ standardSchema: inviteAcceptedSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'CONSENT_REQUIRED',
    'INVITE_INVALID',
    'RATE_LIMITED',
  )
  accept(
    @Param('token', { schema: inviteTokenParam }) _token: string,
  ): InviteAccepted {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('redeem-code')
  @HttpCode(200)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Phụ huynh nhận lời mời bằng mã ngắn (US-0.12 AC2, AC5)',
    description:
      'Cần đăng nhập. Cùng kết quả và cùng quy tắc đồng ý như `accept` (403 `CONSENT_REQUIRED` được kiểm trước mã). ' +
      'Khóa theo user: 5 lần nhập sai (mã không dùng được) trong 15 phút → 429 `INVITE_CODE_LOCKED` kèm `details.retryAfterSec` và header `Retry-After`; lỗi 422 do sai định dạng không tính. ' +
      'Mã sai, hết hạn, đã dùng, bị thu hồi → CÙNG 410 `INVITE_INVALID`. Cũng giới hạn 10 lần/phút mỗi IP → 429 `RATE_LIMITED`.',
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
    @Body({ schema: redeemCodeRequestSchema }) _body: RedeemCodeRequest,
  ): InviteAccepted {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
