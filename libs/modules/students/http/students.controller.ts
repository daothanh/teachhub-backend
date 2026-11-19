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
import {
  ApiErrors,
  ApiErrorWithDetails,
  ApiIdempotencyKey,
  ApiPlanLimitExceeded,
  AppException,
} from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type CreateStudentRequest,
  createStudentRequestSchema,
  type Student,
  type StudentListQuery,
  studentDuplicateDetailsSchema,
  studentListQuerySchema,
  type StudentPage,
  studentPageSchema,
  studentSchema,
  type UpdateStudentRequest,
  updateStudentRequestSchema,
} from './students.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 2 (S1-CT-02); thân hàm ở S2-BE-05.
@ApiTags('students')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('students')
export class StudentsController {
  @Get()
  @ApiOperation({
    summary: 'Danh sách và tìm học viên không dấu (US-1.4)',
    description:
      'Tìm theo `q` (từ 2 ký tự, không phân biệt dấu, dùng `pg_trgm` + `unaccent`); bỏ `q` thì liệt kê tất cả. Lọc `status` (mặc định `active`) và `classId`.',
  })
  @ApiOkResponse({ standardSchema: studentPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Query({ schema: studentListQuerySchema }) _query: StudentListQuery,
  ): StudentPage {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post()
  // Đặt trước các decorator khác: schema 409 phải thắng ErrorBody chung của Idempotency-Key.
  @ApiErrorWithDetails(
    'STUDENT_POSSIBLE_DUPLICATE',
    'StudentDuplicateErrorBody',
    studentDuplicateDetailsSchema,
  )
  @ApiOperation({
    summary: 'Thêm học viên (US-1.4 AC1, AC4)',
    description:
      'Chỉ họ tên bắt buộc. Trùng họ tên và ngày sinh với hồ sơ có sẵn → 409 `STUDENT_POSSIBLE_DUPLICATE` kèm `details.candidates` ' +
      '(`StudentCandidate`: `id`, `fullName`, `dob`, `school`); client hỏi "Có phải cùng một em?", chọn "không" thì gửi lại với `confirmNew: true` (khóa idempotency mới). ' +
      'Chỉ tìm trong tenant hiện tại, tối đa 5 ứng viên. Số điện thoại phụ huynh tùy chọn, lưu vào `guardians`. Hết hạn mức gói → 402 `PLAN_LIMIT_EXCEEDED`.',
  })
  @ApiCreatedResponse({ standardSchema: studentSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  @ApiPlanLimitExceeded()
  create(
    @Body({ schema: createStudentRequestSchema }) _body: CreateStudentRequest,
  ): Student {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Sửa học viên (US-1.4)',
    description:
      'Có `guardians` thì thay toàn bộ danh sách: phụ huynh có `id` được cập nhật, không có `id` được tạo mới, phụ huynh không còn trong danh sách bị gỡ liên kết (lời mời còn hiệu lực của người đó bị thu hồi). ' +
      'Tối đa 2 phụ huynh: thêm người thứ 3 → 422 `VALIDATION_FAILED` (US-1.6 AC1). Gửi lời mời đi qua `POST /students/{id}/invites`, không đi qua endpoint này.',
  })
  @ApiOkResponse({ standardSchema: studentSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  update(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: updateStudentRequestSchema }) _body: UpdateStudentRequest,
  ): Student {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
