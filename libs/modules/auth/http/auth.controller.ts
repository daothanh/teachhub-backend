import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { ApiErrors, AppException, Public, uuidv7 } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Mailer } from '@teachhub/infra';
import { OTP, OtpService } from '../otp/otp.service.js';
import { SessionService } from '../session/session.service.js';
import {
  type GoogleSsoRequest,
  googleSsoRequestSchema,
  type LoginRequest,
  type LoginResponse,
  loginRequestSchema,
  loginResponseSchema,
  type OtpSendRequest,
  otpSendRequestSchema,
  type RefreshRequest,
  type RefreshResponse,
  refreshRequestSchema,
  refreshResponseSchema,
  type User,
  userSchema,
} from './auth.schemas.js';

// Hợp đồng Sprint 1 (S0-CT-01). Thân hàm làm ở S1-BE-03…06; đường dẫn khớp mặc định của tasco_auth (G1).
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly mailer: Mailer,
    private readonly tx: TxService,
    private readonly session: SessionService,
  ) {}

  @Public()
  @Post('otp/send')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Gửi mã OTP 6 số tới email (US-0.1)',
    description:
      'Mã sống 5 phút. Giới hạn 60 giây/lần và 5 lần/giờ mỗi email → 429 kèm `details.retryAfterSec` và header `Retry-After`.',
  })
  @ApiNoContentResponse({
    description: 'Đã gửi (kể cả email chưa có tài khoản)',
  })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  async sendOtp(
    @Body({ schema: otpSendRequestSchema }) body: OtpSendRequest,
  ): Promise<void> {
    const email = body.email.toLowerCase();
    const code = await this.otp.issue(email);
    await this.mailer.send({
      to: email,
      subject: `${code} là mã đăng nhập TeachHub của bạn`,
      text: `Mã đăng nhập TeachHub: ${code}\n\nMã hết hạn sau ${OTP.ttlSec / 60} phút. Không chia sẻ mã này cho ai. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
    });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Đăng nhập bằng email OTP; email chưa có tài khoản = đăng ký (US-0.1 AC1)',
    description:
      'Sai 5 lần → khóa 15 phút: 429 `OTP_LOCKED` kèm `details.retryAfterSec` (AC3).',
  })
  @ApiOkResponse({ standardSchema: loginResponseSchema })
  @ApiErrors('VALIDATION_FAILED', 'OTP_INVALID', 'OTP_LOCKED', 'RATE_LIMITED')
  async login(
    @Body({ schema: loginRequestSchema }) body: LoginRequest,
  ): Promise<LoginResponse> {
    const email = body.email.toLowerCase();
    await this.otp.verify(email, body.code);
    // Email chưa có tài khoản = đăng ký: user chưa có vai trò nào, không tạo tenant (AC1).
    const userId = await this.tx.run({ userId: null }, async (t) => {
      const { rows } = await t.execute<{ id: string }>(
        sql`select app_private.sign_in_identity('email', ${email}, ${email}, ${uuidv7()}, ${uuidv7()}) as id`,
      );
      return rows[0]!.id;
    });
    return this.session.open(userId);
  }

  @Public()
  @Post('sso/google')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Đổi id_token Google lấy token TeachHub',
    description:
      'Kiểm chữ ký, `aud` (client ID iOS/Android/web), `iss`, hạn. Email đã xác minh trùng user có sẵn → gắn vào user đó.',
  })
  @ApiOkResponse({ standardSchema: loginResponseSchema })
  @ApiErrors('VALIDATION_FAILED', 'UNAUTHENTICATED')
  ssoGoogle(
    @Body({ schema: googleSsoRequestSchema }) _body: GoogleSsoRequest,
  ): LoginResponse {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Làm mới token (xoay vòng refresh token)',
    description:
      'Dùng lại refresh token đã xoay → thu hồi cả phiên, 401 `UNAUTHENTICATED`. Hạn trượt 30 ngày, tối đa 90 ngày.',
  })
  @ApiOkResponse({ standardSchema: refreshResponseSchema })
  @ApiErrors('VALIDATION_FAILED', 'TOKEN_EXPIRED', 'UNAUTHENTICATED')
  refresh(
    @Body({ schema: refreshRequestSchema }) _body: RefreshRequest,
  ): RefreshResponse {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Thu hồi phiên hiện tại' })
  @ApiNoContentResponse()
  @ApiErrors('UNAUTHENTICATED')
  logout(): void {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Thông tin user đang đăng nhập' })
  @ApiOkResponse({ standardSchema: userSchema })
  @ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
  me(): User {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
