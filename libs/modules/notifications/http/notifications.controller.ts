import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import {
  type MarkReadRequest,
  markReadRequestSchema,
  type MarkReadResult,
  markReadResultSchema,
  type NotificationsQuery,
  notificationsQuerySchema,
  type NotificationsResponse,
  notificationsResponseSchema,
} from './notifications.schemas.js';

// Hợp đồng Sprint 3 (S2-FL-10); thân hàm ở task backend thông báo (S3-BE-06 trở đi).
@ApiTags('notifications')
@ApiBearerAuth('bearer')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
@Controller('notifications')
export class NotificationsController {
  @Get()
  @ApiOperation({
    summary: 'Hộp thông báo của vai trò đang mở (US-6.1)',
    description:
      'Phân trang con trỏ (Spec §5.5), mới nhất trước. Chỉ trả thông báo gửi cho chính user và đúng vai trò `active-membership`; không bao giờ lộ thông báo của người khác.',
  })
  @ApiOkResponse({ standardSchema: notificationsResponseSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Query({ schema: notificationsQuerySchema }) _query: NotificationsQuery,
  ): NotificationsResponse {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Đánh dấu đã đọc (US-6.1)',
    description:
      'Id trùng trong danh sách chỉ tính một lần. Id của người khác và id không tồn tại không phân biệt: đều bị bỏ qua, không báo lỗi (không dò được id của người khác); id đã đọc cũng bỏ qua.',
  })
  @ApiOkResponse({ standardSchema: markReadResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  read(
    @Body({ schema: markReadRequestSchema }) _body: MarkReadRequest,
  ): MarkReadResult {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
