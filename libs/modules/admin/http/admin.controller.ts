import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtension,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import {
  type BankTransferConfirmed,
  type ConfirmBankTransferRequest,
  confirmBankTransferRequestSchema,
  bankTransferConfirmedSchema,
  type BankTransferListQuery,
  bankTransferListQuerySchema,
  type BankTransferOrderPage,
  bankTransferOrderPageSchema,
  type CreateLegalArticleRequest,
  createLegalArticleRequestSchema,
  type LegalArticle,
  type LegalArticleListQuery,
  legalArticleListQuerySchema,
  type LegalArticlePage,
  legalArticlePageSchema,
  legalArticleSchema,
  type PublishLegalArticleRequest,
  publishLegalArticleRequestSchema,
  type SupportTenant,
  supportTenantSchema,
} from './admin.schemas.js';

const idParam = z.uuid();

/**
 * Xác thực server-to-server của BFF admin (Spec §5.2e): ba header phải có đủ (một yêu cầu bảo mật AND).
 * `permission` là URI quyền IAM duy nhất mà `x-admin-permissions` phải mang cho route này.
 */
const AdminAuth = (permission: string) =>
  applyDecorators(
    ApiSecurity({ adminSecret: [], adminUserId: [], adminPermissions: [] }),
    ApiExtension('x-admin-permission', permission),
    ApiErrors('UNAUTHENTICATED', 'FORBIDDEN'),
  );

// Hợp đồng Sprint 2 (S1-CT-02). AdminGuard thật và thân hàm làm ở task backend riêng; chưa có guard thì
// JwtAuthGuard toàn cục vẫn chặn (401), nên route chưa mở nhầm cho ai.
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  @Get('bank-transfer-orders')
  @AdminAuth('/teachhub/admin/bank-transfer')
  @ApiOperation({
    summary: 'Danh sách đơn chuyển khoản gói Pro (US-0.8 AC3)',
    description:
      'Quyền IAM: `/teachhub/admin/bank-transfer`. `status` mặc định `pending`.',
  })
  @ApiOkResponse({ standardSchema: bankTransferOrderPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  listBankTransferOrders(
    @Query({ schema: bankTransferListQuerySchema })
    _query: BankTransferListQuery,
  ): BankTransferOrderPage {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('bank-transfer-orders/:id/confirm')
  @HttpCode(200)
  @AdminAuth('/teachhub/admin/bank-transfer')
  @ApiOperation({
    summary: 'Xác nhận đã nhận chuyển khoản, kích hoạt Pro (US-0.8 AC3)',
    description:
      'Quyền IAM: `/teachhub/admin/bank-transfer`. Một giao dịch: đơn → `confirmed` (ghi `x-admin-user-id`), `subscriptions` → Pro, `audit_logs`, rồi push cho giáo viên. ' +
      'Body bắt buộc `amount`, `bankTransactionRef`, `expectedUpdatedAt`; đơn không còn `pending` hoặc `expectedUpdatedAt` lệch `updatedAt` → 409 `CONFLICT_STALE`.',
  })
  @ApiOkResponse({ standardSchema: bankTransferConfirmedSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
  confirmBankTransferOrder(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: confirmBankTransferRequestSchema })
    _body: ConfirmBankTransferRequest,
  ): BankTransferConfirmed {
    throw new AppException('NOT_IMPLEMENTED');
  }

  // Bổ sung ngoài bảng Spec §5.4: trang admin cần liệt kê bài để chọn bài phát hành.
  @Get('legal-articles')
  @AdminAuth('/teachhub/admin/legal-articles')
  @ApiOperation({
    summary: 'Danh sách bài quy định, cả bản nháp (US-9.6)',
    description:
      'Quyền IAM: `/teachhub/admin/legal-articles`. Lọc tùy chọn theo `status`.',
  })
  @ApiOkResponse({ standardSchema: legalArticlePageSchema })
  @ApiErrors('VALIDATION_FAILED')
  listLegalArticles(
    @Query({ schema: legalArticleListQuerySchema })
    _query: LegalArticleListQuery,
  ): LegalArticlePage {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('legal-articles')
  @AdminAuth('/teachhub/admin/legal-articles')
  @ApiOperation({
    summary: 'Soạn bài quy định (bản nháp) (US-9.6)',
    description:
      'Quyền IAM: `/teachhub/admin/legal-articles`. Tạo bản nháp `version = 1`; `slug` trùng → 422 `VALIDATION_FAILED` ở trường `slug`.',
  })
  @ApiCreatedResponse({ standardSchema: legalArticleSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  createLegalArticle(
    @Body({ schema: createLegalArticleRequestSchema })
    _body: CreateLegalArticleRequest,
  ): LegalArticle {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('legal-articles/:id/publish')
  @HttpCode(200)
  @AdminAuth('/teachhub/admin/legal-articles')
  @ApiOperation({
    summary: 'Ghi người duyệt và phát hành bài (US-9.6 AC2, AC3)',
    description:
      'Quyền IAM: `/teachhub/admin/legal-articles`. Bắt buộc ghi tên luật sư/kế toán duyệt trước khi hiển thị; phát hành xong giáo viên nhận thông báo trong app. `publishedBy` lấy từ `x-admin-user-id`, không nhận từ body; `reviewedBy` là nhãn văn bản thuần. Bài đã phát hành → 409 `CONFLICT_STALE`.',
  })
  @ApiOkResponse({ standardSchema: legalArticleSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
  publishLegalArticle(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: publishLegalArticleRequestSchema })
    _body: PublishLegalArticleRequest,
  ): LegalArticle {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('support/tenants/:id')
  @AdminAuth('/teachhub/admin/support')
  @ApiOperation({
    summary: 'Tra cứu hỗ trợ một tenant (chỉ đọc)',
    description:
      'Quyền IAM: `/teachhub/admin/support`. Mỗi lần gọi ghi nhật ký truy cập kèm `x-admin-user-id`. Không trả dữ liệu học viên.',
  })
  @ApiOkResponse({ standardSchema: supportTenantSchema })
  @ApiErrors('NOT_FOUND')
  supportTenant(@Param('id', { schema: idParam }) _id: string): SupportTenant {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
