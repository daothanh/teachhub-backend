import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type WebPushSubscribeRequest,
  webPushSubscribeRequestSchema,
  type WebPushUnsubscribeRequest,
  webPushUnsubscribeRequestSchema,
} from './web-push.schemas.js';

// Hợp đồng Sprint 4 (S3-FL-12), P1; thân hàm ở S4-BE-08b. Khóa công khai VAPID web lấy từ cấu hình build của web, không có endpoint.
@ApiTags('web-push')
@ApiBearerAuth('bearer')
@RequiresRole('parent')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('web-push')
export class WebPushController {
  @Post('subscriptions')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Lưu Web Push subscription của trình duyệt (FR-6.2)',
    description:
      'Upsert theo `endpoint`: đăng ký lặp không tạo dòng mới; endpoint đang gắn user khác thì chuyển sang user hiện tại. Không có endpoint đọc lại. ' +
      '`Idempotency-Key` tùy chọn vì lệnh vốn idempotent theo `endpoint`. Nội dung push cũng data-only như FCM: chỉ `notificationId` và `type`.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey(false)
  @ApiErrors('VALIDATION_FAILED')
  subscribe(
    @Body({ schema: webPushSubscribeRequestSchema })
    _body: WebPushSubscribeRequest,
  ): void {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('unsubscribe')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Hủy Web Push subscription (gọi trước khi đăng xuất)',
    description:
      'Bổ sung ngoài Spec §5.4. Idempotent: endpoint không có hoặc không thuộc user → vẫn 204, không lộ endpoint của người khác.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey(false)
  @ApiErrors('VALIDATION_FAILED')
  unsubscribe(
    @Body({ schema: webPushUnsubscribeRequestSchema })
    _body: WebPushUnsubscribeRequest,
  ): void {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
