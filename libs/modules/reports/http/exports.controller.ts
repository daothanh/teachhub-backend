import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import { RequiresFeature } from '@teachhub/modules/subscription';
import {
  type CreateExportRequest,
  createExportRequestSchema,
  type ExportJob,
  exportJobSchema,
} from './exports.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 8 (S7-CT-01), thân hàm 501 tới task backend `reports`. US-8.6 (P1), chỉ `tenant_owner`.
@ApiTags('reports')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('exports')
export class ExportsController {
  @Post()
  @HttpCode(202)
  @RequiresFeature('reports.export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Xuất doanh thu, khoản thu hoặc công nợ ra Excel/CSV (US-8.6)',
    description:
      'Chỉ gói Pro (khóa `reports.export`): gói Miễn phí → 402 `FEATURE_REQUIRES_PRO` kèm `details.feature`. Tạo việc cho worker (BullMQ) rồi trả ngay `queued`; client hỏi `GET /exports/{id}`. Tệp lên bucket private, tiền là số nguyên đồng, ngày dd/mm/yyyy, Σ khớp con số trên màn hình (US-8.6 AC2: cùng truy vấn với `GET /reports/*` và `GET /receivables`). ' +
      'Thiếu `fromMonth`/`toMonth` với `revenue`/`payments`, `toMonth` trước `fromMonth` hoặc quá 24 tháng → 422 `VALIDATION_FAILED`. Giới hạn 10 lần/phút/user.',
  })
  @ApiAcceptedResponse({ standardSchema: exportJobSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  create(
    @Body({ schema: createExportRequestSchema }) _body: CreateExportRequest,
  ): ExportJob {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Trạng thái việc xuất và link tải (US-8.6, US-9.4, US-9.5)',
    description:
      'Dùng chung cho `POST /exports`, `POST /compliance/revenue-book/export` và `POST /compliance/form03/pdf`. Không kiểm gói: tenant đã xuất lúc còn Pro vẫn lấy lại link trong hạn lưu tệp. Việc của tenant khác hoặc không tồn tại → 404 `NOT_FOUND`.',
  })
  @ApiOkResponse({ standardSchema: exportJobSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  get(@Param('id', { schema: idParam }) _id: string): ExportJob {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
