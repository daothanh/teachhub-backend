import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type LegalArticleView,
  type LegalArticleViewListQuery,
  legalArticleViewListQuerySchema,
  type LegalArticleViewPage,
  legalArticleViewPageSchema,
  legalArticleViewSchema,
} from './compliance.schemas.js';

const slugParam = z.string().regex(/^[a-z0-9-]{3,80}$/);

// Hợp đồng Sprint 8 (S7-CT-01), thân hàm 501 tới task backend `compliance`. Phần đọc của thư viện quy định (US-9.6); soạn và phát hành ở `/admin/legal-articles` (Sprint 2).
@ApiTags('compliance')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner', 'teacher')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('legal-articles')
export class LegalArticlesController {
  @Get()
  @ApiOperation({
    summary: 'Danh sách bài quy định đã phát hành (US-9.6 AC1)',
    description:
      'Chỉ bài `published` (bản nháp và bài chưa có người duyệt không bao giờ lộ, US-9.6 AC3), mới cập nhật trước. Mỗi bài có tóm tắt, nội dung, trích dẫn văn bản gốc, ngày cập nhật và dòng "Công cụ hỗ trợ, không thay tư vấn pháp lý". Thông báo "bài đổi" cho mọi giáo viên (US-9.6 AC2) chờ PR `oneOf` của `Notification` (xem CHANGELOG).',
  })
  @ApiOkResponse({ standardSchema: legalArticleViewPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Query({ schema: legalArticleViewListQuerySchema })
    _query: LegalArticleViewListQuery,
  ): LegalArticleViewPage {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Một bài quy định đã phát hành (US-9.6 AC1)',
    description:
      'Dùng cho liên kết từ checklist (`legalArticleSlug`), cảnh báo lớp tiểu học và cảnh báo ngưỡng thuế. Bài nháp hoặc không tồn tại → 404 `NOT_FOUND`.',
  })
  @ApiOkResponse({ standardSchema: legalArticleViewSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  get(@Param('slug', { schema: slugParam }) _slug: string): LegalArticleView {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
