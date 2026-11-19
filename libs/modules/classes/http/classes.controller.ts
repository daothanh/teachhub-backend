import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiIdempotencyKey,
  ApiPlanLimitExceeded,
  AppException,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { ClassesService } from '../application/classes.service.js';
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

// Hợp đồng Sprint 2 (S1-CT-02); S2-BE-03 (lớp), S2-BE-06 (ghi danh), S2-BE-06b (roster).
@ApiTags('classes')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('classes')
export class ClassesController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly classes: ClassesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Danh sách lớp (US-1.1)',
    description:
      '`status=active` (mặc định) hoặc `archived`. Lớp lưu trữ ẩn khỏi lịch.',
  })
  @ApiOkResponse({ standardSchema: classPageSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Ctx() ctx: RequestContext,
    @Query({ schema: classListQuerySchema }) query: ClassListQuery,
  ): Promise<ClassPage> {
    return this.tx.run(ctx, (t) => this.classes.list(t, ctx.tenantId!, query));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết lớp kèm quy tắc lặp (US-1.1, US-2.1)' })
  @ApiOkResponse({ standardSchema: classSchema })
  @ApiErrors('NOT_FOUND')
  get(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<Class> {
    return this.tx.run(ctx, (t) => this.classes.get(t, ctx.tenantId!, id));
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
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createClassRequestSchema }) body: CreateClassRequest,
  ): Promise<ClassCreated> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.classes.create(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        body,
      ),
    }));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Sửa lớp (US-1.1)' })
  @ApiOkResponse({ standardSchema: classSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  update(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updateClassRequestSchema }) body: UpdateClassRequest,
  ): Promise<Class> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.classes.update(t, ctx.tenantId!, id, body),
    }));
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
  archive(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<Class> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.classes.archive(t, ctx.tenantId!, id),
    }));
  }

  @Get(':id/roster')
  @ApiOperation({
    summary: 'Học viên đang ghi danh của lớp (bản tối thiểu)',
    description:
      'Chỉ ghi danh chưa rời lớp (học viên `active` hoặc `paused`). Không phân trang. Nhãn "Giá riêng" và trạng thái phụ huynh thêm ở sprint sau.',
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
