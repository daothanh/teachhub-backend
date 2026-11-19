import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type Class,
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
      'Lịch lặp đặt riêng ở `PUT /classes/{id}/schedule-rules`.',
  })
  @ApiCreatedResponse({ standardSchema: classSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  create(
    @Body({ schema: createClassRequestSchema }) _body: CreateClassRequest,
  ): Class {
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
      'Không phân trang. Nhãn "Giá riêng" và trạng thái phụ huynh thêm ở sprint sau.',
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
      'Dùng chung hồ sơ `students`, không tạo bản trùng. Học viên đã ghi danh mở ở lớp này → 200 với ghi danh sẵn có.',
  })
  @ApiCreatedResponse({ standardSchema: enrollmentSchema })
  @ApiOkResponse({
    standardSchema: enrollmentSchema,
    description: 'Đã ghi danh trước đó',
  })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  enroll(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: createEnrollmentRequestSchema })
    _body: CreateEnrollmentRequest,
  ): Enrollment {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
