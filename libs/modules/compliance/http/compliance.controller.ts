import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { RequiresFeature } from '@teachhub/modules/subscription';
import { ChecklistService } from '../application/checklist.service.js';
import { RevenueBookService } from '../application/revenue-book.service.js';
import type { ItemKey } from '../domain/checklist.js';
import {
  type ExportJob,
  exportJobSchema,
} from '../../reports/http/exports.schemas.js';
import {
  type ComplianceChecklist,
  complianceChecklistSchema,
  complianceItemKeySchema,
  type ExportRevenueBookRequest,
  exportRevenueBookRequestSchema,
  type Form02,
  form02Schema,
  type Form03,
  form03Schema,
  type PublishForm02Request,
  publishForm02RequestSchema,
  type PutSchoolDeclarationRequest,
  putSchoolDeclarationRequestSchema,
  type RevenueBook,
  type RevenueBookQuery,
  revenueBookQuerySchema,
  revenueBookSchema,
  type SchoolDeclaration,
  schoolDeclarationSchema,
  type UpdateChecklistItemRequest,
  updateChecklistItemRequestSchema,
} from './compliance.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 8 (S7-CT-01). Đã làm: checklist, sổ doanh thu, đóng cảnh báo; còn 501: Mẫu 02, khai trường + Mẫu 03, xuất sổ (chờ luật sư/kế toán chốt cột và nghĩa vụ, xem contracts/CHANGELOG.md). Chỉ `tenant_owner` (MVP: giáo viên là chủ tenant).
// Gói Miễn phí: checklist, khai trường, sổ doanh thu và ngưỡng đầy đủ; xem trước Mẫu 02/03 có dữ liệu nhưng công khai/PDF/xuất sổ là Pro (402 `FEATURE_REQUIRES_PRO`).
@ApiTags('compliance')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('compliance')
export class ComplianceController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly checklistSvc: ChecklistService,
    private readonly book: RevenueBookService,
  ) {}

  @Get('checklist')
  @ApiOperation({
    summary: 'Checklist tuân thủ Thông tư 29 (T13, US-9.1)',
    description:
      'Bốn mục theo US-9.1 AC1, kèm % hoàn thành và mục tiếp theo. Tenant mới trả đủ mục ở `todo`; `school_declaration` là `not_applicable` khi đã khai "Không". Mọi gói dùng đủ (US-9.1 AC4). Đủ mọi mục `done` thì ghi sự kiện `compliance_item_completed` mỗi mục (Spec §8).',
  })
  @ApiOkResponse({ standardSchema: complianceChecklistSchema })
  checklist(@Ctx() ctx: RequestContext): Promise<ComplianceChecklist> {
    return this.tx.run(ctx, (t) => this.checklistSvc.get(t, ctx.tenantId!));
  }

  @Patch('checklist/:itemKey')
  @ApiOperation({
    summary: 'Đánh dấu hoặc bỏ đánh dấu một mục checklist (US-9.1 AC3)',
    description:
      'Mục do hệ thống suy ra (`auto = true`: `public_disclosure`, `school_declaration`) → 422 `VALIDATION_FAILED` ở `itemKey`. `registration_number` đặt `done` phải có `data.registrationNo`. Trả checklist mới.',
  })
  @ApiOkResponse({ standardSchema: complianceChecklistSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  updateItem(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('itemKey', { schema: complianceItemKeySchema }) itemKey: ItemKey,
    @Body({ schema: updateChecklistItemRequestSchema })
    body: UpdateChecklistItemRequest,
  ): Promise<ComplianceChecklist> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.checklistSvc.update(t, ctx.tenantId!, itemKey, body),
    }));
  }

  @Get('form02')
  @ApiOperation({
    summary: 'Bảng công khai Mẫu 02 tự điền (T13, US-9.2 AC1, AC4)',
    description:
      'Điền từ lớp `active` (môn, khối, lịch, địa điểm, học phí, người dạy) và chỉ rõ trường còn thiếu theo lớp. Gói Miễn phí vẫn nhận dữ liệu với `featureEnabled = false` để client làm mờ và mời nâng cấp (US-9.2 AC4).',
  })
  @ApiOkResponse({ standardSchema: form02Schema })
  form02(): Form02 {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('form02/publish')
  @HttpCode(200)
  @RequiresFeature('compliance.form02')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Bật hoặc tắt công khai Mẫu 02 (US-9.2 AC2, AC3)',
    description:
      'Chỉ gói Pro (khóa `compliance.form02`): Miễn phí → 402 `FEATURE_REQUIRES_PRO`. Bật công khai: chụp `snapshot` vào `public_disclosures`, sinh `slug` cố định ở lần đầu, đặt `public_disclosure` của checklist `done`, cho worker sinh PDF A4 lên bucket `public`. Dữ liệu lớp đổi sau đó thì snapshot và `updatedAt` tự cập nhật (US-9.2 AC3). ' +
      'Chưa có lớp `active` hoặc còn trường thiếu → 422 `VALIDATION_FAILED` (`errors.rows`: danh sách thiếu). Tắt: `GET /public/disclosures/{slug}` trả 404, checklist về `todo`. Trả Mẫu 02 mới (`pdfStatus` có thể còn `processing`).',
  })
  @ApiOkResponse({ standardSchema: form02Schema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  publishForm02(
    @Body({ schema: publishForm02RequestSchema })
    _body: PublishForm02Request,
  ): Form02 {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('school-declaration')
  @ApiOperation({
    summary: 'Khai báo trường chính khóa đang dạy (US-9.4)',
    description:
      'Bổ sung ngoài bảng Spec §5.4: màn khai báo cần đọc lại giá trị đã khai. Chưa khai trả `teachesAtSchool = null`.',
  })
  @ApiOkResponse({ standardSchema: schoolDeclarationSchema })
  schoolDeclaration(): SchoolDeclaration {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Put('school-declaration')
  @ApiOperation({
    summary:
      'Khai trường và lớp chính khóa, hoặc khai "Không" (US-9.4 AC1, AC3)',
    description:
      'Thay toàn bộ khai báo, gọi lại cùng nội dung cho cùng kết quả. `teachesAtSchool = true` bắt buộc `schoolName` và ít nhất một lớp (thiếu → 422 `VALIDATION_FAILED`); `false` xóa tên và lớp, ẩn Mẫu 03. Cập nhật `tenants.teaches_at_school` và mục `school_declaration` của checklist. Miễn phí dùng đủ. ' +
      'Cảnh báo trùng khi thêm học viên (US-9.4 AC1) làm ở Sprint 9 cùng nhập Excel.',
  })
  @ApiOkResponse({ standardSchema: schoolDeclarationSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  putSchoolDeclaration(
    @Body({ schema: putSchoolDeclarationRequestSchema })
    _body: PutSchoolDeclarationRequest,
  ): SchoolDeclaration {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('form03')
  @ApiOperation({
    summary: 'Biểu mẫu báo cáo Mẫu 03 điền sẵn (T13, US-9.4 AC2)',
    description:
      'Bổ sung ngoài bảng Spec §5.4: xem trước trước khi xuất PDF. Gói Miễn phí nhận dữ liệu với `featureEnabled = false`. Chưa khai hoặc khai "Không": `applicable = false`, `rows` rỗng (US-9.4 AC3).',
  })
  @ApiOkResponse({ standardSchema: form03Schema })
  form03(): Form03 {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('form03/pdf')
  @HttpCode(202)
  @RequiresFeature('compliance.form03')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Xuất PDF báo cáo Mẫu 03 (US-9.4 AC2)',
    description:
      'Chỉ gói Pro (khóa `compliance.form03`): Miễn phí → 402 `FEATURE_REQUIRES_PRO`. Chưa khai hoặc khai "Không" → 422 `VALIDATION_FAILED` ở `teachesAtSchool`. Worker sinh PDF A4 lên bucket private; hỏi `GET /exports/{id}` lấy link tải. Giới hạn 10 lần/phút/user.',
  })
  @ApiAcceptedResponse({ standardSchema: exportJobSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  form03Pdf(): ExportJob {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('revenue-book')
  @ApiOperation({
    summary: 'Sổ doanh thu, lũy kế và ngưỡng thuế của năm (T13, US-9.5)',
    description:
      'Đọc thẳng từ `revenue_ledger` nên khớp từng đồng với báo cáo T12 (cùng sổ, `fiscal_year` theo múi giờ tenant). `thresholds` hai ngưỡng 500 triệu và 1 tỷ kèm thanh tiến độ; `alerts` các cảnh báo 80% (400 triệu, 800 triệu) đã phát sinh: sinh một lần cho mỗi mốc khi lũy kế (theo thứ tự ghi sổ) chạm mốc, không sinh lại khi hủy rồi thu lại (unique `(tenant, năm, mốc)`). Cảnh báo được tính bằng job hằng ngày 08:00 giờ VN và ngay khi mở endpoint này (không nằm trong luồng ghi thanh toán nên không làm chậm nó), nên có thể trễ tới một ngày so với lúc ghi nếu chủ tenant chưa mở sổ. Mọi gói xem được (US-9.5 AC4). `entries` phân trang offset. ' +
      'Cảnh báo kèm push chữ chung cho chủ tenant (loại `tax_threshold_alert`, không số tiền); dòng hộp thư của loại này chờ PR `oneOf` của `Notification` (xem CHANGELOG), tới đó app đọc `alerts` của endpoint này.',
  })
  @ApiOkResponse({ standardSchema: revenueBookSchema })
  @ApiErrors('VALIDATION_FAILED')
  revenueBook(
    @Ctx() ctx: RequestContext,
    @Query({ schema: revenueBookQuerySchema }) query: RevenueBookQuery,
  ): Promise<RevenueBook> {
    return this.tx.run(ctx, (t) => this.book.get(t, ctx.tenantId!, query));
  }

  @Post('revenue-book/export')
  @HttpCode(202)
  @RequiresFeature('revenue.export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Xuất sổ doanh thu ra Excel/CSV/PDF (US-9.5 AC4)',
    description:
      'Chỉ gói Pro (khóa `revenue.export`): Miễn phí → 402 `FEATURE_REQUIRES_PRO` (xem và theo dõi ngưỡng vẫn mở, US-9.5 AC4). Việc xuất bất đồng bộ như `POST /exports`; Σ tệp bằng `cumulativeAmount`. Giới hạn 10 lần/phút/user.',
  })
  @ApiAcceptedResponse({ standardSchema: exportJobSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  exportRevenueBook(
    @Body({ schema: exportRevenueBookRequestSchema })
    _body: ExportRevenueBookRequest,
  ): ExportJob {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('tax-alerts/:id/dismiss')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Đóng một cảnh báo ngưỡng thuế (US-9.5 AC3)',
    description:
      'Đặt `dismissedAt`; gọi lại trên cảnh báo đã đóng vẫn 204. Không xóa cảnh báo và không cho sinh lại. Cảnh báo của tenant khác hoặc không tồn tại → 404 `NOT_FOUND`.',
  })
  @ApiNoContentResponse()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  dismissTaxAlert(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<void> {
    return this.tx.run(ctx, (t) => this.book.dismiss(t, ctx.tenantId!, id));
  }
}
