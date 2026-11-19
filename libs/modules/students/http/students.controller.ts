import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiErrors,
  ApiErrorWithDetails,
  ApiIdempotencyKey,
  ApiPlanLimitExceeded,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { StudentsService } from '../application/students.service.js';
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

// Hợp đồng Sprint 2 (S1-CT-02); S2-BE-05.
@ApiTags('students')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('students')
export class StudentsController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly students: StudentsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Danh sách và tìm học viên không dấu (US-1.4)',
    description:
      'Tìm theo `q` (từ 2 ký tự, không phân biệt dấu, dùng `pg_trgm` + `unaccent`); bỏ `q` thì liệt kê tất cả. Lọc `status` (mặc định `active`) và `classId`.',
  })
  @ApiOkResponse({ standardSchema: studentPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Ctx() ctx: RequestContext,
    @Query({ schema: studentListQuerySchema }) query: StudentListQuery,
  ): Promise<StudentPage> {
    return this.tx.run(ctx, (t) => this.students.list(t, ctx.tenantId!, query));
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
  @ApiErrors('VALIDATION_FAILED', 'CONFLICT_STALE')
  @ApiPlanLimitExceeded()
  create(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createStudentRequestSchema }) body: CreateStudentRequest,
  ): Promise<Student> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.students.create(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        body,
      ),
    }));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Sửa học viên (US-1.4)',
    description:
      'Có `guardians` thì thay toàn bộ danh sách: phụ huynh có `id` được cập nhật, không có `id` được tạo mới, phụ huynh không còn trong danh sách bị gỡ liên kết.',
  })
  @ApiOkResponse({ standardSchema: studentSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  update(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updateStudentRequestSchema }) body: UpdateStudentRequest,
  ): Promise<Student> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.students.update(t, ctx.tenantId!, id, body),
    }));
  }
}
