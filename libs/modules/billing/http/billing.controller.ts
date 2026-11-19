import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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

// Hợp đồng Sprint 5 (S4-FL-10, S4-CT-01); thân hàm ở S5-BE-06 (đọc, điều chỉnh) và S5-BE-07 (phát hành, hủy).
// Chỉ `tenant_owner` (MVP: giáo viên là chủ tenant; Spec §4.8 "chỉ chủ tenant ghi" tài chính). Id của tenant khác → 404.
@ApiTags('billing')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class BillingController {
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
    @Query({ schema: billingPeriodListQuerySchema })
    _query: BillingPeriodListQuery,
  ): BillingPeriodPage {
    throw new AppException('NOT_IMPLEMENTED');
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
    @Param('id', { schema: idParam }) _id: string,
    @Query({ schema: billingPeriodDetailQuerySchema })
    _query: BillingPeriodDetailQuery,
  ): BillingPeriodDetail {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('billing-periods/:id/issue')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Chốt & phát hành hóa đơn của kỳ (US-7.2 AC4, US-7.3)',
    description:
      'Chạy trong một giao dịch: cấp mã duy nhất trong tenant (`TH-xxxxxx`), nội dung chuyển khoản `TH xxxxxx`, `qrPayload` VietQR từ tài khoản nhận tiền chính, chụp `payout` vào hóa đơn rồi khóa bất biến. `invoiceIds = null` là "Chốt & gửi tất cả", mảng là chốt từng hóa đơn. ' +
      'Hóa đơn 0 đ không phát hành, không nhắc nợ (US-1.3 AC3): nằm trong `skipped` với `ZERO_AMOUNT` và vẫn là bản nháp. Hóa đơn đã phát hành hay đã hủy trong `invoiceIds` vào `skipped` với `NOT_DRAFT`. `invoiceIds` chứa id không thuộc kỳ này → 404. ' +
      'Tenant chưa có tài khoản nhận tiền → 422 `PAYOUT_ACCOUNT_MISSING`, không phát hành hóa đơn nào (client mở màn tài khoản nhận tiền, US-7.3 AC5). ' +
      '`Idempotency-Key` bắt buộc: gửi lặp cùng khóa trả lại kết quả đã lưu, gọi lại bằng khóa mới khi đã hết bản nháp thì `issuedCount = 0`, không phát hành hai lần. Mỗi hóa đơn phát hành ghi sự kiện outbox `invoice_issued` → thông báo `invoice_issued` + email cho phụ huynh. ' +
      'Kỳ chuyển `closed` khi không còn bản nháp nào có số tiền > 0.',
  })
  @ApiOkResponse({ standardSchema: issueInvoicesResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'PAYOUT_ACCOUNT_MISSING')
  issue(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: issueInvoicesRequestSchema }) _body: IssueInvoicesRequest,
  ): IssueInvoicesResult {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('invoices/:id')
  @ApiOperation({
    summary: 'Chi tiết hóa đơn: dòng và từng buổi tính/không tính (US-7.2 AC2)',
    description:
      '`lines` là các dòng tiền; `sessions` liệt kê từng buổi của học viên trong kỳ kèm `charged` và `notChargedReason`. Dòng số dư chuyển kỳ (`carry_over`) chỉ có từ Sprint 6. Hóa đơn của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: invoiceSchema })
  @ApiErrors('NOT_FOUND')
  invoice(@Param('id', { schema: idParam }) _id: string): Invoice {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('invoices/:id/adjustments')
  @ApiOperation({
    summary: 'Thêm dòng điều chỉnh vào bản nháp (US-7.2 AC3)',
    description:
      'Chỉ khi hóa đơn còn `draft`; đã phát hành hay hủy → 409 `INVOICE_IMMUTABLE`. Thêm dòng `manual_adjustment` có `amount` ≠ 0 (âm giảm, dương phụ thu), bắt buộc `reason`, ghi nhật ký kiểm toán; trả hóa đơn đã tính lại. ' +
      'Tổng `totalAmount` không âm: điều chỉnh làm tổng < 0 thì `totalAmount = 0` (phần âm chuyển kỳ khi có US-7.6). Chưa có endpoint xóa dòng điều chỉnh: nhập sai thì thêm dòng ngược dấu.',
  })
  @ApiCreatedResponse({ standardSchema: invoiceSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'INVOICE_IMMUTABLE')
  adjust(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: createAdjustmentRequestSchema })
    _body: CreateAdjustmentRequest,
  ): Invoice {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hủy hóa đơn đã phát hành, có lý do (US-7.3 AC4)',
    description:
      'Chỉ hóa đơn `issued`: hóa đơn chưa phát hành (`draft`) → 409 `CONFLICT_STALE`; hóa đơn đã có thanh toán (Sprint 6) cũng 409, phải hủy thanh toán trước. Hóa đơn đã `void` gọi lại vẫn 200, trả bản hiện tại, `replacementInvoiceId = null`. ' +
      'Mã QR của hóa đơn đã hủy không còn hiển thị cho phụ huynh. `createReplacementDraft = true` tạo bản nháp thay thế để giáo viên sửa rồi chốt (xem mô tả trường).',
  })
  @ApiOkResponse({ standardSchema: voidInvoiceResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
  voidInvoice(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: voidInvoiceRequestSchema }) _body: VoidInvoiceRequest,
  ): VoidInvoiceResult {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
