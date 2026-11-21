import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtension,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Public,
} from '@teachhub/core';
import { BankTransferAdminService } from '../application/bank-transfer-admin.service.js';
import { AdminGuard, RequiresAdminPermission } from './admin.guard.js';
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
/** `x-admin-user-id` đã được AdminGuard kiểm (không rỗng). Không dùng `@Headers` vì sẽ khai thành tham số bắt buộc mới trong hợp đồng. */
const adminUserOf = (req: FastifyRequest) =>
  String(req.headers['x-admin-user-id']).trim();

/**
 * Xác thực server-to-server của BFF admin (Spec §5.2e): ba header phải có đủ (một yêu cầu bảo mật AND).
 * `permission` là URI quyền IAM duy nhất mà `x-admin-permissions` phải mang cho route này.
 */
const AdminAuth = (permission: string) =>
  applyDecorators(
    ApiSecurity({ adminSecret: [], adminUserId: [], adminPermissions: [] }),
    ApiExtension('x-admin-permission', permission),
    RequiresAdminPermission(permission),
    ApiErrors('UNAUTHENTICATED', 'FORBIDDEN'),
  );

// Hợp đồng Sprint 2 (S1-CT-02). `AdminGuard` (secret + user id + quyền IAM) thay JWT cho cả controller; chuyển khoản
// đã có thân hàm (S7), bài quy định và tra cứu hỗ trợ còn trả 501 (đã qua guard) tới task admin riêng.
@ApiTags('admin')
@Public()
// Chặt hơn mặc định: BFF nội bộ chỉ cần vài request/phút; chặn dò secret theo IP (khuyến nghị thêm allowlist IP ở Cloudflare).
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly bankTransfers: BankTransferAdminService) {}

  @Get('bank-transfer-orders')
  @AdminAuth('/teachhub/admin/bank-transfer')
  @ApiOperation({
    summary: 'Danh sách đơn chuyển khoản gói Pro (US-0.8 AC3)',
    description:
      'Quyền IAM: `/teachhub/admin/bank-transfer`. `status` mặc định `pending`.',
  })
  @ApiOkResponse({ standardSchema: bankTransferOrderPageSchema })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  listBankTransferOrders(
    @Query({ schema: bankTransferListQuerySchema })
    query: BankTransferListQuery,
    @Req() req: FastifyRequest,
  ): Promise<BankTransferOrderPage> {
    return this.bankTransfers.list(adminUserOf(req), query);
  }

  @Post('bank-transfer-orders/:id/confirm')
  @HttpCode(200)
  @AdminAuth('/teachhub/admin/bank-transfer')
  @ApiOperation({
    summary: 'Xác nhận đã nhận chuyển khoản, kích hoạt Pro (US-0.8 AC3)',
    description:
      'Quyền IAM: `/teachhub/admin/bank-transfer`. Một giao dịch: đơn → `confirmed` (ghi `x-admin-user-id`), `subscriptions` → Pro, `audit_logs`, rồi push cho giáo viên. ' +
      'Body bắt buộc `amount`, `bankTransactionRef`, `expectedUpdatedAt`; đơn không còn `pending` hoặc `expectedUpdatedAt` lệch `updatedAt` → 409 `CONFLICT_STALE`. ' +
      'Kỳ Pro 12 tháng (giá Pro là giá một năm): đang Pro còn hạn thì cộng nối từ hạn hiện tại, không rút ngắn; `amount` phải bằng số tiền của đơn, lệch → 422 `VALIDATION_FAILED` ở trường `amount`. ' +
      'Gọi lại cùng `bankTransactionRef` và `amount` bởi cùng người xác nhận → 200 với kết quả cũ (không cộng kỳ lần hai); khác đi → 409 `CONFLICT_STALE`. ' +
      '`bankTransactionRef` đã dùng cho đơn khác → 409 `BANK_TRANSACTION_REF_USED`; tenant đang Pro `active` qua App Store/Google Play còn hạn → 409 `SUBSCRIPTION_STORE_MANAGED` (không cộng nối, không đổi nguồn); dùng thử hoặc chuyển khoản thì cộng nối. Giới hạn 30 lần/phút/IP cho cả nhóm `/admin`.',
  })
  @ApiOkResponse({ standardSchema: bankTransferConfirmedSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'CONFLICT_STALE',
    'BANK_TRANSACTION_REF_USED',
    'SUBSCRIPTION_STORE_MANAGED',
    'RATE_LIMITED',
  )
  confirmBankTransferOrder(
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: confirmBankTransferRequestSchema })
    body: ConfirmBankTransferRequest,
    @Req() req: FastifyRequest,
  ): Promise<BankTransferConfirmed> {
    // Khóa phát lại do chính trạng thái đơn bảo đảm (xác nhận lặp không cộng kỳ hai); header chỉ cần đúng dạng (hợp đồng bắt buộc).
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !z.uuid().safeParse(key).success)
      throw new AppException('VALIDATION_FAILED', undefined, {
        'Idempotency-Key': ['Bắt buộc, dạng UUID'],
      });
    return this.bankTransfers.confirm(
      { userId: adminUserOf(req), requestId: req.id, ip: req.ip },
      id,
      body,
    );
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
