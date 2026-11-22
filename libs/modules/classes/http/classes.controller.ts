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
  ApiNoContentResponse,
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
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { ClassesService } from '../application/classes.service.js';
import { EnrollmentsService } from '../application/enrollments.service.js';
import {
  type AcknowledgeClassWarningRequest,
  acknowledgeClassWarningRequestSchema,
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
    private readonly enrollments: EnrollmentsService,
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
      'Lịch lặp đặt riêng ở `PUT /classes/{id}/schedule-rules`. Phản hồi là lớp kèm `warnings` (không chặn): lớp khối 1 đến 5 môn văn hóa có `TT29_PRIMARY_ACADEMIC` (US-9.3 AC1), xác nhận qua `POST /classes/{id}/warning-acknowledgements`; môn nghệ thuật, thể thao, kỹ năng sống không cảnh báo (nhận diện theo tên môn). ' +
      'Hết hạn mức gói → 402 `PLAN_LIMIT_EXCEEDED`.',
  })
  @ApiCreatedResponse({ standardSchema: classCreatedSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'CONFLICT_STALE')
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
  @ApiOperation({
    summary: 'Sửa lớp (US-1.1)',
    description:
      'Đổi ngày bắt đầu hoặc kết thúc thì buổi dự kiến tương lai được đối chiếu lại trong cùng giao dịch. Lớp đã lưu trữ → 409 `CONFLICT_STALE`.',
  })
  @ApiOkResponse({ standardSchema: classSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
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
      'Chỉ ghi danh chưa rời lớp (học viên `active` hoặc `paused`). Không phân trang. Mỗi học viên kèm `inviteStatus` (chưa mời / đã mời / đã kích hoạt / hết hạn, US-1.6 AC4) và danh sách phụ huynh với trạng thái từng người, kèm `latestInvite` (id, hạn). "Mời tất cả phụ huynh chưa kích hoạt" chỉ lặp trên phụ huynh `not_invited` (gọi tạo lời mời) và `expired` (gọi `resend` bằng `latestInvite.id`); bỏ qua `invited` (đang còn hiệu lực) và `activated`. Nhãn "Giá riêng" thêm ở sprint sau.',
  })
  @ApiOkResponse({ standardSchema: rosterSchema })
  @ApiErrors('NOT_FOUND')
  roster(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<Roster> {
    return this.tx.run(ctx, (t) =>
      this.enrollments.roster(t, ctx.tenantId!, id),
    );
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
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    // Trạng thái 200/201 do `Idempotency.run` đặt qua `reply.status` (như WorkspacesController).
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: createEnrollmentRequestSchema })
    body: CreateEnrollmentRequest,
  ): Promise<Enrollment> {
    return this.idem.run(req, reply, ctx, (t) =>
      this.enrollments.enroll(t, ctx.tenantId!, id, body),
    );
  }
  // Hợp đồng Sprint 8 (S7-CT-01), thân hàm ở task backend `compliance`. US-9.3 AC3 (cảnh báo, không chặn).
  @Post(':id/warning-acknowledgements')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Xác nhận "Tôi đã hiểu, vẫn tạo" cảnh báo TT29 của lớp (US-9.3 AC3)',
    description:
      'Lớp đã được tạo kèm `warnings` (không chặn); lời gọi này ghi xác nhận vào nhật ký (`acknowledgements`, `kind = class_warning`, `entity_id` = lớp, người xác nhận). Gọi lại cùng `code` vẫn 204 (không ghi trùng). `code` không nằm trong `warnings` hiện có của lớp → 422 `VALIDATION_FAILED`. Lớp của tenant khác → 404 `NOT_FOUND`.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  async acknowledgeWarning(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: acknowledgeClassWarningRequestSchema })
    body: AcknowledgeClassWarningRequest,
  ): Promise<void> {
    await this.idem.run(req, reply, ctx, async (t) => ({
      status: 204,
      body: await this.classes.acknowledgeWarning(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body.code,
      ),
    }));
  }
}
