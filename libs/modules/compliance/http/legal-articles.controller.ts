import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, Ctx, type RequestContext } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { LegalArticlesService } from '../application/legal-articles.service.js';
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

// Hợp đồng Sprint 8 (S7-CT-01). Phần đọc của thư viện quy định (US-9.6); soạn và phát hành ở `/admin/legal-articles` (Sprint 2).
@ApiTags('compliance')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner', 'teacher')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('legal-articles')
export class LegalArticlesController {
  constructor(
    private readonly tx: TxService,
    private readonly articles: LegalArticlesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Danh sách bài quy định đã phát hành (US-9.6 AC1)',
    description:
      'Chỉ bài `published` (bản nháp và bài chưa có người duyệt không bao giờ lộ, US-9.6 AC3), mới cập nhật trước. Mỗi bài có tóm tắt, nội dung, trích dẫn văn bản gốc, ngày cập nhật và dòng "Công cụ hỗ trợ, không thay tư vấn pháp lý". Thông báo "bài đổi" cho mọi giáo viên (US-9.6 AC2) chờ PR `oneOf` của `Notification` (xem CHANGELOG).',
  })
  @ApiOkResponse({ standardSchema: legalArticleViewPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Ctx() ctx: RequestContext,
    @Query({ schema: legalArticleViewListQuerySchema })
    query: LegalArticleViewListQuery,
  ): Promise<LegalArticleViewPage> {
    return this.tx.run(ctx, (t) => this.articles.list(t, query));
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Một bài quy định đã phát hành (US-9.6 AC1)',
    description:
      'Dùng cho liên kết từ checklist (`legalArticleSlug`), cảnh báo lớp tiểu học và cảnh báo ngưỡng thuế. Bài nháp hoặc không tồn tại → 404 `NOT_FOUND`.',
  })
  @ApiOkResponse({ standardSchema: legalArticleViewSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  get(
    @Ctx() ctx: RequestContext,
    @Param('slug', { schema: slugParam }) slug: string,
  ): Promise<LegalArticleView> {
    return this.tx.run(ctx, (t) => this.articles.get(t, slug));
  }
}
