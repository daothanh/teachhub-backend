import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
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
import { BillingService } from '../application/billing.service.js';
import {
  type BillingPeriodDetail,
  billingPeriodDetailSchema,
  type BillingPeriodDetailQuery,
  billingPeriodDetailQuerySchema,
  type BillingPeriodListQuery,
  billingPeriodListQuerySchema,
  type BillingPeriodPage,
  billingPeriodPageSchema,
  type CreateAdjustmentRequest,
  createAdjustmentRequestSchema,
  type Invoice,
  invoiceSchema,
  type IssueInvoicesRequest,
  issueInvoicesRequestSchema,
  type IssueInvoicesResult,
  issueInvoicesResultSchema,
  type VoidInvoiceRequest,
  voidInvoiceRequestSchema,
  type VoidInvoiceResult,
  voidInvoiceResultSchema,
} from './billing.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 5 (S4-FL-10, S4-CT-01); đọc/điều chỉnh (S5-BE-06), phát hành/hủy (S5-BE-07).
// Chỉ `tenant_owner` (MVP: giáo viên là chủ tenant; Spec §4.8 "chỉ chủ tenant ghi" tài chính). Id của tenant khác → 404.
@ApiTags('billing')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class BillingController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly billing: BillingService,
  ) {}

  @Get('billing-periods')
  @ApiOperation({
    summary: 'Danh sách kỳ thu (T10, US-7.2)',
    description:
      'Mới nhất trước, phân trang offset. Kỳ do tác vụ nền `billing.close` (02:00) tạo cho tenant có ngày chốt hôm nay; chạy lại không tạo bản nháp trùng (US-7.2 AC1). `month=YYYY-MM` lọc đúng một tháng. ' +
      'Kỳ gồm tiền: mọi số tiền là số nguyên đồng.',
  })
  @ApiOkResponse({ standardSchema: billingPeriodPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Ctx() ctx: RequestContext,
    @Query({ schema: billingPeriodListQuerySchema })
    query: BillingPeriodListQuery,
  ): Promise<BillingPeriodPage> {
    return this.tx.run(ctx, (t) =>
      this.billing.listPeriods(t, ctx.tenantId!, query),
    );
  }

  @Get('billing-periods/:id')
  @ApiOperation({
    summary: 'Chi tiết kỳ thu: số bản nháp, tổng tiền, danh sách hóa đơn (T10)',
    description:
      'Tổng quan kỳ kèm `invoices` phân trang (sắp theo tên học viên không dấu). Mở chi tiết từng hóa đơn bằng `GET /invoices/{id}`. Kỳ của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: billingPeriodDetailSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  get(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
    @Query({ schema: billingPeriodDetailQuerySchema })
    query: BillingPeriodDetailQuery,
  ): Promise<BillingPeriodDetail> {
    return this.tx.run(ctx, (t) =>
      this.billing.getPeriod(t, ctx.tenantId!, id, query),
    );
  }

  @Post('billing-periods/:id/issue')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Chốt & phát hành hóa đơn của kỳ (US-7.2 AC4, US-7.3)',
    description:
      'Chạy trong một giao dịch: cấp mã duy nhất trong tenant (`TH-xxxxxx`), nội dung chuyển khoản `TH xxxxxx`, `qrPayload` VietQR từ tài khoản nhận tiền chính, chụp `payout` vào hóa đơn rồi khóa bất biến. `invoiceIds = null` là "Chốt & gửi tất cả", mảng là chốt từng hóa đơn. ' +
      'Hóa đơn 0 đ không phát hành, không nhắc nợ (US-1.3 AC3): nằm trong `skipped` với `ZERO_AMOUNT` và vẫn là bản nháp. Hóa đơn đã phát hành hay đã hủy trong `invoiceIds` vào `skipped` với `NOT_DRAFT`. `invoiceIds` chứa id không thuộc kỳ này → 404. ' +
      'Tenant chưa có tài khoản nhận tiền → 422 `PAYOUT_ACCOUNT_MISSING`, không phát hành hóa đơn nào (client mở màn tài khoản nhận tiền, US-7.3 AC5). ' +
      '`Idempotency-Key` bắt buộc: gửi lặp cùng khóa trả lại kết quả đã lưu, gọi lại bằng khóa mới khi đã hết bản nháp thì `issuedCount = 0`, không phát hành hai lần. Mỗi hóa đơn phát hành ghi sự kiện outbox `invoice_issued` → thông báo `invoice_issued` + email cho phụ huynh. ' +
      'Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`). Kỳ chuyển `closed` khi không còn bản nháp nào có số tiền > 0.',
  })
  @ApiOkResponse({ standardSchema: issueInvoicesResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'PAYOUT_ACCOUNT_MISSING',
    'RATE_LIMITED',
  )
  issue(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: issueInvoicesRequestSchema }) body: IssueInvoicesRequest,
  ): Promise<IssueInvoicesResult> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.billing.issue(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body,
      ),
    }));
  }

  @Get('invoices/:id')
  @ApiOperation({
    summary:
      'Chi tiết hóa đơn: các dòng, từng buổi tính/không tính (US-7.2 AC2)',
    description:
      '`lines` là nguồn duy nhất và là snapshot lúc tính (không đọc lại điểm danh). Kiểu theo buổi: mỗi buổi một dòng `session` kèm `charged`, `notChargedReason`, `sessionDate`, kể cả buổi hủy và buổi bù 0 đ. Kiểu theo tháng và trọn khóa: một dòng gốc (không có dòng buổi), kèm `installmentNo`/`installmentCount` với trọn khóa. Dòng số dư chuyển kỳ (`carry_over`) chỉ có từ Sprint 6. Hóa đơn của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: invoiceSchema })
  @ApiErrors('NOT_FOUND')
  invoice(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<Invoice> {
    return this.tx.run(ctx, (t) =>
      this.billing.getInvoice(t, ctx.tenantId!, id),
    );
  }

  @Post('invoices/:id/adjustments')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Thêm dòng điều chỉnh vào bản nháp (US-7.2 AC3)',
    description:
      'Chỉ khi hóa đơn còn `draft`; đã phát hành hay hủy → 409 `INVOICE_IMMUTABLE`. Thêm dòng `manual_adjustment` có `amount` ≠ 0 (âm giảm, dương phụ thu), bắt buộc `adjustmentReason`, ghi nhật ký kiểm toán; trả hóa đơn đã tính lại. Mỗi hóa đơn tối đa 20 dòng điều chỉnh, vượt → 422 `VALIDATION_FAILED`. Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`). ' +
      'Tổng `totalAmount` không âm: điều chỉnh làm tổng < 0 thì `totalAmount = 0` và `clampedAmount` là phần âm bị cắt (chuyển kỳ khi có US-7.6). Chưa có endpoint xóa dòng điều chỉnh: nhập sai thì thêm dòng ngược dấu.',
  })
  @ApiCreatedResponse({ standardSchema: invoiceSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'INVOICE_IMMUTABLE',
    'RATE_LIMITED',
  )
  adjust(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: createAdjustmentRequestSchema })
    body: CreateAdjustmentRequest,
  ): Promise<Invoice> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.billing.adjust(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body,
      ),
    }));
  }

  @Post('invoices/:id/void')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hủy hóa đơn đã phát hành, có lý do (US-7.3 AC4)',
    description:
      'Chỉ hóa đơn `issued`: hóa đơn chưa phát hành (`draft`) → 409 `CONFLICT_STALE`; hóa đơn đã có thanh toán (Sprint 6) cũng 409, phải hủy thanh toán trước. Hóa đơn đã `void` gọi lại vẫn 200, trả bản hiện tại, `replacementInvoiceId = null`. ' +
      'Mã QR của hóa đơn đã hủy không còn hiển thị cho phụ huynh (`payout` và `qrPayload` null phía phụ huynh). `createReplacementDraft = true` chưa hỗ trợ ở MVP → 422 `VALIDATION_FAILED`, `replacementInvoiceId` luôn null; hóa đơn thay thế = tạo lại bản nháp rồi chốt. Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`).',
  })
  @ApiOkResponse({ standardSchema: voidInvoiceResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE', 'RATE_LIMITED')
  voidInvoice(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: voidInvoiceRequestSchema }) body: VoidInvoiceRequest,
  ): Promise<VoidInvoiceResult> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.billing.voidInvoice(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body,
      ),
    }));
  }
}
