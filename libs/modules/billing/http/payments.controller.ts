import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { PaymentsService } from '../application/payments.service.js';
import {
  type PaymentList,
  paymentListSchema,
  type PaymentResult,
  paymentResultSchema,
  type RecordPaymentRequest,
  recordPaymentRequestSchema,
  type VoidPaymentRequest,
  voidPaymentRequestSchema,
} from './payments.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 6 (S5-FL-09, S5-CT-01); S6-BE-02. Chỉ `tenant_owner` (MVP: giáo viên là chủ tenant).
// Id của tenant khác → 404. Ghi tiền giới hạn 20 lần/phút/user.
@ApiTags('billing')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class PaymentsController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly payments: PaymentsService,
  ) {}

  @Post('invoices/:id/payments')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Ghi đã thu đủ hoặc thu một phần cho hóa đơn (US-7.4 AC1, AC2)',
    description:
      'Chạy trong MỘT giao dịch có khóa hàng hóa đơn (`SELECT … FOR UPDATE`): thêm `payments`, tính lại trạng thái hóa đơn (`partially_paid` khi 0 < Σ < `totalAmount`, `paid` khi Σ ≥ `totalAmount`), ghi `student_ledger` (phần trả thừa) và `revenue_ledger` (một dòng đúng số tiền, US-9.5 AC1), ghi nhật ký kiểm toán, hủy các lời nhắc nợ chưa gửi khi thu đủ (US-7.5 AC2). ' +
      'Sự kiện outbox `payment_recorded` sinh thông báo `payment_recorded` cho phụ huynh trong ≤ 1 phút (US-7.4 AC3); phụ huynh mở `GET /family/invoices/{id}` làm biên nhận. ' +
      '`amount` nhỏ hơn số còn nợ là thu một phần; bằng là thu đủ; lớn hơn vẫn nhận, hóa đơn `paid` và `overpaidAmount` > 0 (vào sổ học viên, trừ ở kỳ sau, US-7.6 AC2). `paidOn` mặc định hôm nay theo múi giờ tenant, sau hôm nay → 422 `VALIDATION_FAILED`. ' +
      'Chỉ hóa đơn `issued`, `partially_paid` hoặc `pending_confirmation`; hóa đơn `draft`, `void` hay đã `paid` → 409 `INVOICE_NOT_PAYABLE`. Hóa đơn đã `paid` không nhận thêm: muốn nhận thêm tiền thì ghi vào kỳ sau (trả thừa ở lần ghi cuối đã vào sổ học viên). ' +
      '`Idempotency-Key` bắt buộc: gửi lại cùng khóa khi request đầu đang chạy → 409 `IDEMPOTENCY_IN_PROGRESS`; bấm lặp khi mạng chập chờn trả lại đúng kết quả đã lưu, chỉ có MỘT thanh toán; cùng khóa khác nội dung → 422 `IDEMPOTENCY_KEY_REUSED`. Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`). ' +
      'Số tiền là số nguyên đồng. Hóa đơn của tenant khác → 404.',
  })
  @ApiCreatedResponse({ standardSchema: paymentResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'INVOICE_NOT_PAYABLE',
    'RATE_LIMITED',
  )
  record(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: recordPaymentRequestSchema }) body: RecordPaymentRequest,
  ): Promise<PaymentResult> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.payments.record(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body,
      ),
    }));
  }

  @Get('invoices/:id/payments')
  @ApiOperation({
    summary: 'Danh sách thanh toán của hóa đơn (US-7.4)',
    description:
      'Mọi thanh toán của hóa đơn, mới ghi trước, gồm cả thanh toán đã hủy (`voidedAt` khác null, kèm `voidReason`, `voidedBy`) và có `recordedBy`. Hóa đơn `void` vẫn trả danh sách thanh toán cũ. Hóa đơn chưa có thanh toán → `items` rỗng. Bản nháp, hóa đơn của tenant khác hoặc không tồn tại → 404.',
  })
  @ApiOkResponse({ standardSchema: paymentListSchema })
  @ApiErrors('NOT_FOUND')
  list(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<PaymentList> {
    return this.tx.run(ctx, (t) => this.payments.list(t, ctx.tenantId!, id));
  }

  @Post('payments/:id/void')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hủy thanh toán ghi nhầm, có lý do (US-7.4 AC4)',
    description:
      'Bắt buộc `reason`. Không xóa dòng: đặt `voidedAt`, `voidReason`, ghi bút toán đảo vào `revenue_ledger` (US-9.5 AC1) và `student_ledger` (đảo phần trả thừa nếu có), ghi nhật ký kiểm toán; tính lại trạng thái hóa đơn từ Σ thanh toán còn hiệu lực (có thể về `partially_paid` hoặc `issued`). Chạy trong một giao dịch có khóa hàng hóa đơn. ' +
      'Hóa đơn còn nợ trở lại thì các mốc nhắc nợ chưa tới được lập lại. Nếu phần trả thừa đã được trừ vào hóa đơn kỳ sau thì vẫn hủy được: số dư sổ học viên có thể thành nợ, chuyển kỳ tiếp theo (không sửa hóa đơn đã phát hành). Không báo phụ huynh riêng: biên nhận hiện `voidedAt` ở `GET /family/invoices/{id}`. ' +
      'Hủy lại thanh toán đã hủy (khóa mới) vẫn 200, trả bản hiện tại, giữ `voidReason` và `voidedBy` ban đầu, không ghi bút toán thứ hai; cùng khóa → phát lại kết quả đã lưu. `Idempotency-Key` bắt buộc (request cùng khóa đang chạy → 409 `IDEMPOTENCY_IN_PROGRESS`, khác nội dung → 422 `IDEMPOTENCY_KEY_REUSED`). Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`). Thanh toán của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: paymentResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'RATE_LIMITED')
  voidPayment(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: voidPaymentRequestSchema }) body: VoidPaymentRequest,
  ): Promise<PaymentResult> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.payments.void(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body,
      ),
    }));
  }
}
