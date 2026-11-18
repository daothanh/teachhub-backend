import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import {
  ApiErrors,
  AppException,
  Ctx,
  Public,
  type RequestContext,
  uuidv7,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Mailer } from '@teachhub/infra';
import { GoogleIdTokenService } from '../google/google-id-token.service.js';
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
    private readonly google: GoogleIdTokenService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
    return this.signIn('email', email, email, null, true);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sso/google')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Đổi id_token Google lấy token TeachHub',
    description:
      'Kiểm chữ ký, `aud` (client ID iOS/Android/web), `iss`, hạn. Email đã xác minh trùng user có sẵn → gắn vào user đó.',
  })
  @ApiOkResponse({ standardSchema: loginResponseSchema })
  @ApiErrors('VALIDATION_FAILED', 'UNAUTHENTICATED')
  async ssoGoogle(
    @Body({ schema: googleSsoRequestSchema }) body: GoogleSsoRequest,
  ): Promise<LoginResponse> {
    const g = await this.google.verify(body.id_token);
    return this.signIn(
      'google',
      g.subject,
      g.email,
      g.name,
      g.emailAuthoritative,
    );
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
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
    @Body({ schema: refreshRequestSchema }) body: RefreshRequest,
  ): Promise<RefreshResponse> {
    return this.session.refresh(body.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Thu hồi phiên hiện tại' })
  @ApiNoContentResponse()
  @ApiErrors('UNAUTHENTICATED')
  logout(@Ctx() ctx: RequestContext): Promise<void> {
    return this.session.close(ctx.userId!, ctx.sessionId!);
  }

  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Thông tin user đang đăng nhập' })
  @ApiOkResponse({ standardSchema: userSchema })
  @ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
  me(@Ctx() ctx: RequestContext): Promise<User> {
    return this.session.user(ctx.userId!);
  }

  /**
   * Sau khi danh tính đã xác minh: identity có sẵn → user cũ; email trùng user có sẵn → gắn vào user đó;
   * chưa có → đăng ký (user chưa vai trò, không tenant — US-0.1 AC1). Rồi mở phiên.
   */
  private async signIn(
    provider: 'email' | 'google',
    subject: string,
    email: string,
    name: string | null,
    /** Nhà cung cấp có thẩm quyền với email → được gộp/tạo user theo email; không thì chỉ identity đã có. */
    linkByEmail: boolean,
  ): Promise<LoginResponse> {
    const userId = await this.tx.run({ userId: null }, async (t) => {
      const { rows } = await t.execute<{ id: string | null }>(
        sql`select app_private.sign_in_identity(${provider}, ${subject}, ${email}, ${uuidv7()}, ${uuidv7()}, ${linkByEmail}) as id`,
      );
      return rows[0]?.id;
    });
    // Nhà cung cấp không có thẩm quyền với email (Google với email ngoài Gmail/Workspace): dùng OTP.
    if (!userId) {
      throw new AppException('UNAUTHENTICATED', {
        reason: 'EMAIL_REQUIRES_OTP',
      });
    }
    if (name) {
      await this.tx.run({ userId }, (t) =>
        t.execute(
          sql`update users set display_name = ${name} where id = ${userId} and display_name is null`,
        ),
      );
    }
    return this.session.open(userId);
  }
}
