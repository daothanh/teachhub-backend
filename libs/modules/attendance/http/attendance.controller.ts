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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type AttendanceHistory,
  type AttendanceHistoryQuery,
  attendanceHistoryQuerySchema,
  attendanceHistorySchema,
  type AttendanceSyncRequest,
  attendanceSyncRequestSchema,
  type AttendanceSyncResult,
  attendanceSyncResultSchema,
  type SessionAttendance,
  sessionAttendanceSchema,
} from './attendance.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 3 (S2-FL-10); thân hàm ở S3-BE-02 (đọc, sync), S3-BE-03 (nhật ký).
@ApiTags('attendance')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class AttendanceController {
  @Get('sessions/:id/attendance')
  @ApiOperation({
    summary: 'Danh sách điểm danh của một buổi (US-3.1, US-3.3)',
    description:
      'Trả học viên đang học của lớp kèm trạng thái đã ghi (`null` nếu chưa). Chỉ trả họ tên, trạng thái, ghi chú; không trả liên hệ hay phụ huynh. ' +
      'Buổi quá 7 ngày (tính theo ngày buổi học, múi giờ tenant) hoặc buổi đã hủy: `canEdit = false`, `editableUntil` cho biết hạn. Buổi của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: sessionAttendanceSchema })
  @ApiErrors('NOT_FOUND')
  get(@Param('id', { schema: idParam }) _id: string): SessionAttendance {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('attendance/sync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lưu và đồng bộ điểm danh theo lô (US-3.1, US-3.3, US-3.5)',
    description:
      'Một đường chung cho lưu online, đồng bộ offline và sửa sau (không có PATCH riêng). Tối đa 500 mutation, một buổi mỗi lô. ' +
      'Kết quả theo từng phần tử, HTTP 200 kể cả khi có phần tử `rejected`/`stale`. ' +
      '`clientMutationId` đã nhận → `duplicate`; bản trên server mới hơn (LWW theo `clientUpdatedAt`, có hiệu chỉnh lệch đồng hồ) → `stale`; buổi quá 7 ngày → `rejected` kèm `ATTENDANCE_EDIT_WINDOW_CLOSED`. ' +
      'Lỗi cả lô: buổi không có → 404 `NOT_FOUND`, buổi đã hủy → 409 `SESSION_CANCELLED`; client đánh dấu lô lỗi, giữ lại cho người dùng xem và không retry vô hạn. Báo vắng cho phụ huynh gửi sau commit, qua outbox.',
  })
  @ApiOkResponse({ standardSchema: attendanceSyncResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'SESSION_CANCELLED')
  sync(
    @Body({ schema: attendanceSyncRequestSchema })
    _body: AttendanceSyncRequest,
  ): AttendanceSyncResult {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('sessions/:id/attendance/history')
  @ApiOperation({
    summary: 'Nhật ký sửa điểm danh của buổi (US-3.3 AC2)',
    description:
      'Đọc từ `audit_logs`: người sửa, thời điểm, trạng thái trước và sau. Mới nhất trước, phân trang con trỏ (`limit` tối đa 100). Chỉ trả `changedByName`, không trả userId hay email người sửa.',
  })
  @ApiOkResponse({ standardSchema: attendanceHistorySchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  history(
    @Param('id', { schema: idParam }) _id: string,
    @Query({ schema: attendanceHistoryQuerySchema })
    _query: AttendanceHistoryQuery,
  ): AttendanceHistory {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
