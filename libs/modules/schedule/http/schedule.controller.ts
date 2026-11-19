import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type PutScheduleRulesRequest,
  putScheduleRulesRequestSchema,
  type ScheduleRulesResult,
  scheduleRulesResultSchema,
  type SessionsQuery,
  sessionsQuerySchema,
  type SessionsResponse,
  sessionsResponseSchema,
} from './schedule.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 2 (S1-CT-02); thân hàm ở S2-BE-08.
@ApiTags('schedule')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class ScheduleController {
  @Put('classes/:id/schedule-rules')
  @ApiOperation({
    summary: 'Thay bộ quy tắc lặp của lớp và sinh buổi (US-2.1)',
    description:
      'Thay toàn bộ quy tắc, sinh buổi "dự kiến" trong cùng giao dịch: từ ngày bắt đầu tới ngày kết thúc của lớp, hoặc cuốn chiếu 8 tuần nếu lớp không có ngày kết thúc. ' +
      'Chỉ buổi tương lai chưa điểm danh bị thay; buổi đã dạy giữ nguyên. Gửi lại cùng `Idempotency-Key` không sinh buổi trùng. ' +
      'Trùng (thứ + giờ bắt đầu) hoặc giờ bắt đầu + thời lượng vượt 24:00 → 422 `VALIDATION_FAILED`; lớp đã lưu trữ → 409 `CONFLICT_STALE`.',
  })
  @ApiOkResponse({ standardSchema: scheduleRulesResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
  putRules(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: putScheduleRulesRequestSchema })
    _body: PutScheduleRulesRequest,
  ): ScheduleRulesResult {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('sessions')
  @ApiOperation({
    summary: 'Buổi học trong khoảng ngày (US-2.1, US-2.3)',
    description:
      'Sắp theo `startsAt`. `from` và `to` là ngày theo múi giờ của tenant, bao gồm cả hai đầu. ' +
      'Ngoại lệ có chủ ý so với quy ước chung: khoảng tối đa 62 ngày và không phân trang. Lớp đã lưu trữ không xuất hiện.',
  })
  @ApiOkResponse({ standardSchema: sessionsResponseSchema })
  @ApiErrors('VALIDATION_FAILED')
  sessions(
    @Query({ schema: sessionsQuerySchema }) _query: SessionsQuery,
  ): SessionsResponse {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
