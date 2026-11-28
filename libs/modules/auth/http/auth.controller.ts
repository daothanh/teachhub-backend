import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
import { AppleAndroidService } from '../apple/apple-android.service.js';
import { AppleIdTokenService } from '../apple/apple-id-token.service.js';
import { GoogleIdTokenService } from '../google/google-id-token.service.js';
import { OTP, OtpService } from '../otp/otp.service.js';
import { SessionService } from '../session/session.service.js';
import {
  type AppleAndroidCallback,
  type AppleAndroidRedeemRequest,
  type AppleAndroidRedeemResponse,
  type AppleAndroidStartRequest,
  type AppleAndroidStartResponse,
  appleAndroidCallbackSchema,
  appleAndroidRedeemRequestSchema,
  appleAndroidRedeemResponseSchema,
  appleAndroidStartRequestSchema,
  appleAndroidStartResponseSchema,
  type AppleSsoRequest,
  appleSsoRequestSchema,
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
    private readonly apple: AppleIdTokenService,
    private readonly appleAndroid: AppleAndroidService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/send')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Gửi mã OTP 6 số tới email (US-0.1)',
    description:
      'Mã sống 5 phút. Giới hạn 60 giây/lần và 5 lần/giờ mỗi email → 429 kèm `details.retryAfterSec` và header `Retry-After`. IP đang bị khóa với email này (sai mã 5 lần) → 429 `RATE_LIMITED`; IP khác vẫn gửi được.',
  })
  @ApiNoContentResponse({
    description: 'Đã gửi (kể cả email chưa có tài khoản)',
  })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  async sendOtp(
    @Req() req: FastifyRequest,
    @Body({ schema: otpSendRequestSchema }) body: OtpSendRequest,
  ): Promise<void> {
    const email = body.email.toLowerCase();
    const code = await this.otp.issue(email, req.ip, body.purpose);
    const what =
      body.purpose === 'delete_account'
        ? 'xác nhận xóa tài khoản'
        : body.purpose === 'payout_account'
          ? 'xác nhận tài khoản nhận tiền'
          : 'đăng nhập';
    await this.mailer.send({
      to: email,
      subject: `${code} là mã ${what} TeachHub của bạn`,
      text: `Mã ${what} TeachHub: ${code}\n\nMã hết hạn sau ${OTP.ttlSec / 60} phút. Không chia sẻ mã này cho ai. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
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
      'Sai 5 lần từ cùng một IP (IPv6 gộp theo /64) → khóa IP đó với email này 15 phút: 429 `OTP_LOCKED` kèm `details.retryAfterSec` (AC3); IP khác không bị khóa. Mọi IP cộng lại sai quá 20 lần trong 1 giờ cho một email (không đặt lại khi gửi mã mới; nhập đúng thì đặt lại) → mã bị hủy và mọi lượt nhập trả 401 `OTP_INVALID` tới hết giờ đó.',
  })
  @ApiOkResponse({ standardSchema: loginResponseSchema })
  @ApiErrors('VALIDATION_FAILED', 'OTP_INVALID', 'OTP_LOCKED', 'RATE_LIMITED')
  async login(
    @Req() req: FastifyRequest,
    @Body({ schema: loginRequestSchema }) body: LoginRequest,
  ): Promise<LoginResponse> {
    const email = body.email.toLowerCase();
    await this.otp.verify(email, body.code, req.ip);
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
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sso/apple')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Đổi identityToken Apple lấy token TeachHub (US-0.1)',
    description:
      'Kiểm chữ ký theo JWKS Apple, `aud`, `iss`, hạn và `nonce`. Email đã xác minh trùng user có sẵn → gắn vào user đó.',
  })
  @ApiOkResponse({ standardSchema: loginResponseSchema })
  @ApiErrors('VALIDATION_FAILED', 'UNAUTHENTICATED', 'RATE_LIMITED')
  async ssoApple(
    @Body({ schema: appleSsoRequestSchema }) body: AppleSsoRequest,
  ): Promise<LoginResponse> {
    const a = await this.apple.verify(body.id_token, body.nonce);
    // Không có email (đăng nhập lại): chỉ identity đã có. Email chưa xác minh: không gộp, không tạo (như Google).
    // Relay: tạo user với địa chỉ relay (duy nhất theo người dùng + app, không ai khác giữ được) rồi không bao giờ gộp theo email thật.
    // shortcut: user có sẵn mang đúng địa chỉ relay này vẫn được gắn lại (chỉ chính chủ có địa chỉ đó); upgrade khi có cột cờ.
    const email = a.email ?? '';
    const linkByEmail =
      a.email !== null && (a.emailMergeable || a.isPrivateRelay);
    try {
      return await this.signIn(
        'apple',
        a.subject,
        email,
        body.fullName || null,
        linkByEmail,
        true,
      );
    } catch (e) {
      // Lỗi sau xác minh (yêu cầu OTP, DB, mở phiên): trả khóa để client gửi lại cùng token.
      await this.apple.release(body.id_token);
      throw e;
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sso/apple/android/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bắt đầu đăng nhập Apple trên Android bằng S256' })
  @ApiOkResponse({ standardSchema: appleAndroidStartResponseSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE')
  appleAndroidStart(
    @Body({ schema: appleAndroidStartRequestSchema }) body: AppleAndroidStartRequest,
  ): Promise<AppleAndroidStartResponse> {
    return this.appleAndroid.start(body.code_challenge);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sso/apple/android/callback')
  @HttpCode(303)
  @ApiConsumes('application/x-www-form-urlencoded')
  @ApiOperation({ summary: 'Nhận form POST từ Apple và đưa trình duyệt về app Android' })
  @ApiResponse({
    status: 303,
    description: 'Mở app qua deep link chỉ mang mã dùng một lần',
    headers: { Location: { schema: { type: 'string' } } },
  })
  @ApiResponse({ status: 415, description: 'Chỉ nhận form URL-encoded' })
  @ApiErrors(
    'BAD_REQUEST',
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
  )
  async appleAndroidCallback(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Body({ schema: appleAndroidCallbackSchema }) body: AppleAndroidCallback,
  ): Promise<void> {
    const mediaType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/x-www-form-urlencoded') {
      throw new UnsupportedMediaTypeException();
    }
    const location = await this.appleAndroid.callback(body);
    void reply.redirect(location, 303);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sso/apple/android/redeem')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đổi mã Apple Android lấy phiên TeachHub hoặc kết quả hủy' })
  @ApiOkResponse({ standardSchema: appleAndroidRedeemResponseSchema })
  @ApiErrors(
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'NOT_FOUND',
    'RATE_LIMITED',
    'SERVICE_UNAVAILABLE',
  )
  async appleAndroidRedeem(
    @Body({ schema: appleAndroidRedeemRequestSchema }) body: AppleAndroidRedeemRequest,
  ): Promise<AppleAndroidRedeemResponse> {
    const result = await this.appleAndroid.redeem(body.code, body.code_verifier);
    if (result.status === 'cancelled') return result;
    return this.signIn(
      'apple',
      result.subject,
      result.email ?? '',
      result.name,
      result.email !== null,
      true,
    );
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Làm mới token (xoay vòng refresh token)',
    description:
      'Dùng lại refresh token đã xoay → thu hồi cả phiên, 401 `UNAUTHENTICATED`. Ngoại lệ: gửi lại đúng token vừa xoay trong 30 giây (phản hồi lần trước bị rớt) → 200, trả lại refresh token đã cấp ở lần xoay đó kèm access token mới, phiên không bị thu hồi; token đó đã bị xoay tiếp hoặc phiên đã đăng xuất thì vẫn tính là dùng lại. Hạn trượt 30 ngày, tối đa 90 ngày.',
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
    provider: 'email' | 'google' | 'apple',
    subject: string,
    email: string,
    name: string | null,
    /** Nhà cung cấp có thẩm quyền với email → được gộp/tạo user theo email; không thì chỉ identity đã có. */
    linkByEmail: boolean,
    /** Apple: tên client gửi không có chữ ký → chỉ ghi cho user vừa tạo. shortcut: "vừa tạo" = created_at trong 1 phút (hàm SQL không trả cờ created, không được thêm migration). */
    nameOnlyForNewUser = false,
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
          sql`update users set display_name = ${name} where id = ${userId} and display_name is null
            and (${!nameOnlyForNewUser}::boolean or created_at > now() - interval '1 minute')`,
        ),
      );
    }
    return this.session.open(userId);
  }
}
