import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, Public } from '@teachhub/core';
import { RevenueCatService } from '../application/revenuecat.service.js';
import { RevenueCatSecretGuard } from './revenuecat-secret.guard.js';
import {
  type RevenueCatWebhookRequest,
  revenueCatWebhookRequestSchema,
  type RevenueCatWebhookResult,
  revenueCatWebhookResultSchema,
} from './subscription.schemas.js';

// Hợp đồng Sprint 7 (S6-FL-06, S6-CT-01). Không JWT: `@Public()` + guard so bí mật REVENUECAT_WEBHOOK_SECRET (chưa cấu hình → 401).
@ApiTags('webhooks')
@ApiSecurity('revenuecatSecret')
@ApiErrors('UNAUTHENTICATED')
@Public()
@UseGuards(RevenueCatSecretGuard)
@Controller('webhooks')
export class RevenueCatWebhookController {
  constructor(private readonly revenuecat: RevenueCatService) {}

  @Post('revenuecat')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Webhook RevenueCat cập nhật gói Pro (US-0.8 AC2)',
    description:
      'RevenueCat gọi server-to-server, không có JWT. Xác thực bằng header `Authorization` mang giá trị bí mật đặt trong cấu hình webhook, so sánh thời gian hằng (Spec §7.1); sai hoặc thiếu → 401 `UNAUTHENTICATED`. Idempotent theo `event.id` (bảng `subscription_events`, `event_id` duy nhất): gửi lại → 200 `duplicate`. ' +
      'Một giao dịch: ghi sự kiện, cập nhật `subscriptions` (`planCode`, `status`, `source`, `currentPeriodEnd`, `externalRef`) rồi `audit_logs`; Pro có hiệu lực ≤ 1 phút, app không cần khởi động lại. Mọi sự kiện hợp lệ nhưng không áp dụng trả 200 `ignored` (không 4xx) để RevenueCat không thử lại vô ích; chỉ sai chữ ký trả 401 và thân sai định dạng trả 422 `VALIDATION_FAILED`. Quy tắc từng loại sự kiện ghi ở `RevenueCatEvent.type`. ' +
      'Chỉ kích hoạt Pro khi `product_id` nằm trong danh sách cho phép phía server (thiếu hoặc lạ → `ignored`) và `expiration_at_ms` ở tương lai (mua một lần không có hạn: lấy thời lượng cấu hình của sản phẩm, không có cấu hình → `ignored`). `EXPIRATION` chỉ hạ gói khi gói hiện tại đang trả phí bằng đúng kho đó. Chưa cấu hình bí mật phía server → 401 như sai bí mật.',
  })
  @ApiOkResponse({ standardSchema: revenueCatWebhookResultSchema })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  receive(
    @Body({ schema: revenueCatWebhookRequestSchema })
    body: RevenueCatWebhookRequest,
  ): Promise<RevenueCatWebhookResult> {
    return this.revenuecat.handle(body);
  }
}
