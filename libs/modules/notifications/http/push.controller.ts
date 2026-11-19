import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
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
  @Post('register')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Đăng ký token FCM của thiết bị (FR-6.2)',
    description:
      'Upsert theo `deviceToken`: đăng ký lặp không tạo dòng mới; token đang gắn user khác thì chuyển sang user hiện tại. Mọi vai trò dùng chung. `Idempotency-Key` tùy chọn vì lệnh vốn idempotent theo `deviceToken`. ' +
      '`userId` ở body chỉ để khớp hợp đồng gói `tasco_notifications`: server so với user của token, lệch → 403 `FORBIDDEN`, và không bao giờ dùng `userId` ở body làm danh tính. ' +
      'Push gửi tới thiết bị là data-only, chỉ có `notificationId` và `type`; không có tên con, lớp hay trạng thái vắng trên khay thông báo. App `GET /notifications` sau khi mở để lấy nội dung.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey(false)
  @ApiErrors('VALIDATION_FAILED', 'FORBIDDEN')
  register(
    @Body({ schema: pushRegisterRequestSchema }) _body: PushRegisterRequest,
  ): void {
    throw new AppException('NOT_IMPLEMENTED');
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
  unregister(
    @Body({ schema: pushUnregisterRequestSchema }) _body: PushUnregisterRequest,
  ): void {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
