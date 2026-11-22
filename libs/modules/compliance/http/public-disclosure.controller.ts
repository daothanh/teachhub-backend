import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, AppException, Public } from '@teachhub/core';
import {
  type PublicDisclosure,
  publicDisclosureSchema,
} from './compliance.schemas.js';

const slugParam = z.string().regex(/^[a-z0-9-]{3,80}$/);

// Hợp đồng Sprint 8 (S7-CT-01), thân hàm 501 tới task backend `compliance`. Không JWT: trang công khai `/cong-khai/:slug` (US-9.2 AC2).
@ApiTags('compliance')
@Public()
@Controller('public')
export class PublicDisclosureController {
  @Get('disclosures/:slug')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Dữ liệu trang công khai Mẫu 02 (CK, US-9.2 AC2, AC3)',
    description:
      'Không cần đăng nhập. Chỉ trả khi `is_published`; slug không có hoặc đã tắt công khai → cùng 404 `NOT_FOUND` (không lộ slug có tồn tại). Đọc `snapshot` nên khớp ngày cập nhật hiện trên trang; không chứa dữ liệu học viên hay phụ huynh. Có thể cache ngắn ở Cloudflare (`Cache-Control: public, max-age=60`). Giới hạn 120 lần/phút/IP.',
  })
  @ApiOkResponse({ standardSchema: publicDisclosureSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'RATE_LIMITED')
  get(@Param('slug', { schema: slugParam }) _slug: string): PublicDisclosure {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
