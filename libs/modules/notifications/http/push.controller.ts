import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { DevicesService } from '../application/devices.service.js';
import {
  type PushRegisterRequest,
  pushRegisterRequestSchema,
  type PushUnregisterRequest,
  pushUnregisterRequestSchema,
} from './notifications.schemas.js';

// Hợp đồng Sprint 3 (S2-FL-10); thân hàm ở S3-BE-05. Đường dẫn theo Spec G10 (gói `tasco_notifications`).
@ApiTags('devices')
@ApiBearerAuth('bearer')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
@Controller('push')
export class PushController {
  constructor(
    private readonly tx: TxService,
    private readonly devices: DevicesService,
  ) {}

  /** `userId` ở body chỉ để khớp hợp đồng gói app: không bao giờ là danh tính, lệch token → 403. */
  private assertSelf(ctx: RequestContext, bodyUserId: string): string {
    if (!ctx.userId || bodyUserId !== ctx.userId) {
      throw new AppException('FORBIDDEN');
    }
    return ctx.userId;
  }

  @Post('register')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Đăng ký token FCM của thiết bị (FR-6.2)',
    description:
      'Upsert theo `deviceToken`: đăng ký lặp không tạo dòng mới; token đang gắn user khác thì chuyển sang user hiện tại. Mọi vai trò dùng chung. `Idempotency-Key` tùy chọn vì lệnh vốn idempotent theo `deviceToken`. ' +
      '`userId` ở body chỉ để khớp hợp đồng gói `tasco_notifications`: server so với user của token, lệch → 403 `FORBIDDEN`, và không bao giờ dùng `userId` ở body làm danh tính. ' +
      'Push gửi tới thiết bị có khối `notification` với tiêu đề và nội dung chung theo loại (không tên con, lớp, số tiền) cùng `data` chỉ có `notificationId` và `type`; kênh Android `attendance`/`billing`/`general`. App `GET /notifications` sau khi mở để lấy nội dung.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey(false)
  @ApiErrors('VALIDATION_FAILED', 'FORBIDDEN')
  async register(
    @Ctx() ctx: RequestContext,
    @Body({ schema: pushRegisterRequestSchema }) body: PushRegisterRequest,
  ): Promise<void> {
    const userId = this.assertSelf(ctx, body.userId);
    await this.tx.run({ userId }, (t) =>
      this.devices.register(t, body.deviceToken, body.platform),
    );
  }

  @Post('unregister')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Huỷ token FCM (gọi trước khi đăng xuất)',
    description:
      'Idempotent: token không có hoặc không thuộc user → vẫn 204, không lộ token của người khác.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey(false)
  @ApiErrors('VALIDATION_FAILED', 'FORBIDDEN')
  async unregister(
    @Ctx() ctx: RequestContext,
    @Body({ schema: pushUnregisterRequestSchema }) body: PushUnregisterRequest,
  ): Promise<void> {
    const userId = this.assertSelf(ctx, body.userId);
    await this.tx.run({ userId }, (t) =>
      this.devices.unregister(t, userId, body.deviceToken),
    );
  }
}
