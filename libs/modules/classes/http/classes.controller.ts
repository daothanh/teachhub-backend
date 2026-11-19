import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  ApiPlanLimitExceeded,
  AppException,
} from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type Class,
  type ClassCreated,
  classCreatedSchema,
  type ClassListQuery,
  classListQuerySchema,
  type ClassPage,
  classPageSchema,
  classSchema,
  type CreateClassRequest,
  createClassRequestSchema,
  type CreateEnrollmentRequest,
  createEnrollmentRequestSchema,
  type Enrollment,
  enrollmentSchema,
  type Roster,
  rosterSchema,
  type UpdateClassRequest,
  updateClassRequestSchema,
} from './classes.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 2 (S1-CT-02); thân hàm ở S2-BE-03, S2-BE-06, S2-BE-06b.
@ApiTags('classes')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('classes')
export class ClassesController {
  @Get()
  @ApiOperation({
    summary: 'Danh sách lớp (US-1.1)',
    description:
      '`status=active` (mặc định) hoặc `archived`. Lớp lưu trữ ẩn khỏi lịch.',
  })
  @ApiOkResponse({ standardSchema: classPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Query({ schema: classListQuerySchema }) _query: ClassListQuery,
  ): ClassPage {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết lớp kèm quy tắc lặp (US-1.1, US-2.1)' })
  @ApiOkResponse({ standardSchema: classSchema })
  @ApiErrors('NOT_FOUND')
  get(@Param('id', { schema: idParam }) _id: string): Class {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post()
  @ApiOperation({
    summary: 'Tạo lớp (US-1.1 AC1, AC2)',
    description:
      'Bắt buộc tên, môn, khối, hình thức, ngày bắt đầu; địa điểm bắt buộc với lớp tại chỗ; ngày kết thúc không nhỏ hơn ngày bắt đầu. Sai → 422 `VALIDATION_FAILED` kèm `errors` theo trường. ' +
      'Lịch lặp đặt riêng ở `PUT /classes/{id}/schedule-rules`. Phản hồi là lớp kèm `warnings` (mặc định rỗng). ' +
      'Hết hạn mức gói → 402 `PLAN_LIMIT_EXCEEDED`.',
  })
  @ApiCreatedResponse({ standardSchema: classCreatedSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  @ApiPlanLimitExceeded()
  create(
    @Body({ schema: createClassRequestSchema }) _body: CreateClassRequest,
  ): ClassCreated {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Sửa lớp (US-1.1)' })
  @ApiOkResponse({ standardSchema: classSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  update(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: updateClassRequestSchema }) _body: UpdateClassRequest,
  ): Class {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lưu trữ lớp (US-1.1 AC3)',
    description: 'Lớp đã lưu trữ thì gọi lại vẫn 200, trả lớp hiện tại.',
  })
  @ApiOkResponse({ standardSchema: classSchema })
  @ApiIdempotencyKey()
  @ApiErrors('NOT_FOUND')
  archive(@Param('id', { schema: idParam }) _id: string): Class {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get(':id/roster')
  @ApiOperation({
    summary: 'Học viên đang ghi danh của lớp (bản tối thiểu)',
    description:
      'Chỉ ghi danh chưa rời lớp (học viên `active` hoặc `paused`). Không phân trang. Mỗi học viên kèm `inviteStatus` (chưa mời / đã mời / đã kích hoạt / hết hạn, US-1.6 AC4) và danh sách phụ huynh với trạng thái từng người, để màn "Mời tất cả phụ huynh chưa kích hoạt" biết gọi mời cho ai. Nhãn "Giá riêng" thêm ở sprint sau.',
  })
  @ApiOkResponse({ standardSchema: rosterSchema })
  @ApiErrors('NOT_FOUND')
  roster(@Param('id', { schema: idParam }) _id: string): Roster {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post(':id/enrollments')
  @ApiOperation({
    summary: 'Ghi danh học viên có sẵn vào lớp (US-1.4 AC3)',
    description:
      'Dùng chung hồ sơ `students`, không tạo bản trùng. Học viên đã ghi danh mở ở lớp này → 200 với ghi danh sẵn có. ' +
      'Lớp đã lưu trữ hoặc học viên đã nghỉ (`left`) → 409 `CONFLICT_STALE`. Hết hạn mức gói → 402.',
  })
  @ApiCreatedResponse({ standardSchema: enrollmentSchema })
  @ApiOkResponse({
    standardSchema: enrollmentSchema,
    description: 'Đã ghi danh trước đó',
  })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
  @ApiPlanLimitExceeded()
  enroll(
    // Trạng thái 200/201 do thân hàm đặt qua `reply.status` (như WorkspacesController).
    @Res({ passthrough: true }) _reply: FastifyReply,
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: createEnrollmentRequestSchema })
    _body: CreateEnrollmentRequest,
  ): Enrollment {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
