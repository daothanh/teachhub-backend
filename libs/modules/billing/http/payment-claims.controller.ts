import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type CreatePaymentClaimRequest,
  createPaymentClaimRequestSchema,
  type PaymentClaim,
  type PaymentClaimList,
  paymentClaimListSchema,
  paymentClaimSchema,
  type ResolvePaymentClaimRequest,
  type ResolvePaymentClaimResult,
  resolvePaymentClaimRequestSchema,
  resolvePaymentClaimResultSchema,
} from './payment-claims.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 8 (S7-CT-01), thân hàm 501 tới task backend `billing`. US-7.7 (P1).
@ApiTags('billing')
@ApiBearerAuth('bearer')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class PaymentClaimsController {
  @Post('family/invoices/:id/payment-claims')
  @RequiresRole('parent')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Phụ huynh báo đã chuyển khoản kèm ảnh biên lai (P03, US-7.7 AC1)',
    description:
      'Tệp biên lai tải trước bằng `POST /files/upload-urls` (`purpose = receipt`, `entityId` = hóa đơn) và `complete`. Một giao dịch: ghi `payment_claims` (`pending`), hóa đơn `issued`/`partially_paid` → `pending_confirmation`, hủy các lời nhắc nợ chưa gửi (tạm dừng, US-7.7 AC1; chạy lại khi bị từ chối) và đưa vào outbox sự kiện `payment_claim_created` để giáo viên nhận push. ' +
      'Hóa đơn của học viên chưa liên kết, của tenant khác, nháp hoặc không tồn tại → 404 `NOT_FOUND`. Hóa đơn đã hủy, đã thu đủ hoặc chưa phát hành → 409 `INVOICE_NOT_PAYABLE`. Đã có lần báo `pending` → 409 `CONFLICT_STALE` (không tạo trùng; chờ giáo viên xử lý). ' +
      'Chưa đồng ý điều khoản → 403 `CONSENT_REQUIRED`. Học sinh (`student`) gọi → 403 như mọi API học phí. Giới hạn 10 lần/phút/user.',
  })
  @ApiCreatedResponse({ standardSchema: paymentClaimSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'INVOICE_NOT_PAYABLE',
    'CONFLICT_STALE',
    'CONSENT_REQUIRED',
    'RATE_LIMITED',
  )
  create(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: createPaymentClaimRequestSchema })
    _body: CreatePaymentClaimRequest,
  ): PaymentClaim {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('invoices/:id/payment-claims')
  @RequiresRole('tenant_owner')
  @ApiOperation({
    summary: 'Các lần phụ huynh báo đã chuyển khoản của một hóa đơn (US-7.7)',
    description:
      'Bổ sung ngoài bảng Spec §5.4: giáo viên cần xem biên lai và `claim.id` để xử lý. Hóa đơn của tenant khác hoặc không tồn tại → 404 `NOT_FOUND`.',
  })
  @ApiOkResponse({ standardSchema: paymentClaimListSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  list(@Param('id', { schema: idParam }) _id: string): PaymentClaimList {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('payment-claims/:id/resolve')
  @HttpCode(200)
  @RequiresRole('tenant_owner')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Giáo viên xác nhận hoặc "Chưa nhận được" (US-7.7 AC2, AC3)',
    description:
      '`confirm`: xử lý như US-7.4 với hình thức chuyển khoản (thanh toán `bank_transfer`, dòng `revenue_ledger`, hủy nhắc nợ nếu thu đủ), lần báo `confirmed`. `reject`: lần báo `rejected` kèm `reason`, hóa đơn trở về `issued` hoặc `partially_paid` theo tổng thanh toán, nhắc nợ lập lại theo lịch (US-7.5), phụ huynh nhận thông báo. ' +
      'Lần báo không còn `pending` (đã xử lý, hoặc hóa đơn đã hủy) → 409 `CONFLICT_STALE`; gọi lại cùng `Idempotency-Key` trả đúng kết quả cũ. Lần báo của tenant khác hoặc không tồn tại → 404 `NOT_FOUND`. Giới hạn 20 lần/phút/user.',
  })
  @ApiOkResponse({ standardSchema: resolvePaymentClaimResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE', 'RATE_LIMITED')
  resolve(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: resolvePaymentClaimRequestSchema })
    _body: ResolvePaymentClaimRequest,
  ): ResolvePaymentClaimResult {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
