import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, AppException } from '@teachhub/core';
import {
  type RevenueCatWebhookRequest,
  revenueCatWebhookRequestSchema,
  type RevenueCatWebhookResult,
  revenueCatWebhookResultSchema,
} from './subscription.schemas.js';

// Hợp đồng Sprint 7 (S6-FL-06, S6-CT-01). Chưa có `@Public()` và guard bí mật: JwtAuthGuard toàn cục vẫn chặn (401) nên
// route chưa mở nhầm; task backend `subscription` thêm `@Public()` cùng guard so sánh header bí mật (như AdminGuard của S1-CT-02).
@ApiTags('webhooks')
@ApiSecurity('revenuecatSecret')
@ApiErrors('UNAUTHENTICATED')
@Controller('webhooks')
export class RevenueCatWebhookController {
  @Post('revenuecat')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Webhook RevenueCat cập nhật gói Pro (US-0.8 AC2)',
    description:
      'RevenueCat gọi server-to-server, không có JWT. Xác thực bằng header `Authorization` mang giá trị bí mật đặt trong cấu hình webhook, so sánh thời gian hằng (Spec §7.1); sai hoặc thiếu → 401 `UNAUTHENTICATED`. Idempotent theo `event.id` (bảng `subscription_events`, `event_id` duy nhất): gửi lại → 200 `duplicate`. ' +
      'Một giao dịch: ghi sự kiện, cập nhật `subscriptions` (`planCode`, `status`, `source`, `currentPeriodEnd`, `externalRef`) rồi `audit_logs`; Pro có hiệu lực ≤ 1 phút, app không cần khởi động lại. Mọi sự kiện hợp lệ nhưng không áp dụng trả 200 `ignored` (không 4xx) để RevenueCat không thử lại vô ích; chỉ sai chữ ký trả 401 và thân sai định dạng trả 422 `VALIDATION_FAILED`. Quy tắc từng loại sự kiện ghi ở `RevenueCatEvent.type`.',
  })
  @ApiOkResponse({ standardSchema: revenueCatWebhookResultSchema })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  receive(
    @Body({ schema: revenueCatWebhookRequestSchema })
    _body: RevenueCatWebhookRequest,
  ): RevenueCatWebhookResult {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
