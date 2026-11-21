import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { PlanService } from '../application/plan.service.js';
import { SubscriptionService } from '../application/subscription.service.js';
import {
  type CreateBankTransferOrderRequest,
  createBankTransferOrderRequestSchema,
  type PlanUsage,
  planUsageSchema,
  subscriptionBankTransferOrderSchema,
  type SubscriptionBankTransferOrder,
} from './subscription.schemas.js';

// Hợp đồng Sprint 7 (S6-FL-06, S6-CT-01): gói và dùng thử cho giáo viên (T14). Chỉ `tenant_owner`.
@ApiTags('subscription')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class SubscriptionController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly plans: PlanService,
    private readonly subscription: SubscriptionService,
  ) {}

  @Get('plan-usage')
  @ApiOperation({
    summary:
      'Gói hiện tại, giới hạn, mức dùng và feature flag (US-0.7, US-0.8)',
    description:
      'Một lần gọi cho màn T14 (biến thể theo `plan.trialAvailable`), chip "Pro · còn N ngày" ở tab Thêm và nhãn khóa "Pro". Giới hạn và feature flag được backend thực thi ở mọi route (US-0.7 AC4): tạo lớp/học sinh vượt giới hạn → 402 `PLAN_LIMIT_EXCEEDED`, tính năng Pro → 402 `FEATURE_REQUIRES_PRO`, mục chỉ đọc → 402 `READONLY_PLAN_LIMIT`; client mở T14 khi gặp 402. Dữ liệu thật của gói do `subscription.lifecycle` (06:00 hằng ngày) và webhook cập nhật.',
  })
  @ApiOkResponse({ standardSchema: planUsageSchema })
  planUsage(@Ctx() ctx: RequestContext): Promise<PlanUsage> {
    return this.tx.run(ctx, (t) => this.plans.usage(t, ctx.tenantId!));
  }

  @Post('subscription/trial')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Bắt đầu dùng thử Pro 14 ngày (US-0.8 AC1)',
    description:
      'Mở ngay toàn bộ tính năng Pro: `status = trialing`, `currentPeriodEnd` = bây giờ + 14 ngày, ghi `trialUsedAt`. Mỗi tenant một lần: đã dùng thử → 422 `TRIAL_ALREADY_USED`; đang `trialing` hoặc `active` → 409 `CONFLICT_STALE`. Không có body. Trả `PlanUsage` mới để client đóng T14 và hiện "Đã bật Pro dùng thử · còn 14 ngày". Hết dùng thử mà chưa trả phí: `status = expired`, không xóa dữ liệu (US-0.8 AC4); nhắc còn 7 ngày và 1 ngày do `subscription.lifecycle` (US-0.8 AC5).',
  })
  @ApiOkResponse({ standardSchema: planUsageSchema })
  @ApiIdempotencyKey()
  @ApiErrors('CONFLICT_STALE', 'TRIAL_ALREADY_USED', 'RATE_LIMITED')
  startTrial(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PlanUsage> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.subscription.startTrial(t, { tenantId: ctx.tenantId! }),
    }));
  }

  @Post('subscription/bank-transfer-orders')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Tạo đơn mua Pro bằng chuyển khoản, chỉ trên web (US-0.8 AC3)',
    description:
      'Dành cho client web (R6, Spec §10): app không gọi và không dẫn link tới đây. Trả số tiền, nội dung chuyển khoản, tài khoản nhận và chuỗi QR cho màn T14a, trạng thái `pending`. Tenant đã có đơn `pending` → trả lại chính đơn đó (vẫn 201, không tạo trùng). Pro chỉ kích hoạt khi quản trị xác nhận đã nhận tiền (`POST /admin/bank-transfer-orders/{id}/confirm`, đã có từ Sprint 2), kèm push cho giáo viên; client đọc `GET /plan-usage` để thấy gói mới. Giới hạn 5 lần/phút/user. Chưa cấu hình giá hoặc tài khoản nhận tiền phía server → 503 `SERVICE_UNAVAILABLE`.',
  })
  @ApiCreatedResponse({ standardSchema: subscriptionBankTransferOrderSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE')
  createBankTransferOrder(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createBankTransferOrderRequestSchema })
    _body: CreateBankTransferOrderRequest,
  ): Promise<SubscriptionBankTransferOrder> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.subscription.createBankTransferOrder(t, {
        tenantId: ctx.tenantId!,
        userId: ctx.userId!,
      }),
    }));
  }
}
