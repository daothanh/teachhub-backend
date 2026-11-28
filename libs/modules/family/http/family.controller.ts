import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { AbsenceRequestsService } from '../application/absence-requests.service.js';
import { FamilyService } from '../application/family.service.js';
import {
  type AbsenceRequest,
  absenceRequestListQuerySchema,
  type AbsenceRequestList,
  absenceRequestListSchema,
  type AbsenceRequestListQuery,
  absenceRequestSchema,
  type CreateAbsenceRequest,
  createAbsenceRequestSchema,
  type FamilyAttendanceQuery,
  familyAttendanceQuerySchema,
  type FamilyAttendanceWeek,
  familyAttendanceWeekSchema,
  type FamilyStudentList,
  familyStudentListSchema,
} from './family.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 4 (S3-FL-12); S4-BE-06. Chỉ đọc. RLS qua `linked_student_ids()` là lớp 2.
@ApiTags('family')
@ApiBearerAuth('bearer')
@RequiresRole('parent')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN', 'CONSENT_REQUIRED')
@Controller('family')
export class FamilyController {
  constructor(
    private readonly family: FamilyService,
    private readonly absences: AbsenceRequestsService,
    private readonly idem: Idempotency,
  ) {}

  @Get('students')
  @ApiOperation({
    summary: 'Các con của phụ huynh (P02, US-0.3)',
    description:
      'Chỉ học viên đã liên kết với user qua lời mời đã nhận, ở mọi tenant (phụ huynh nhiều giáo viên thấy hết, US-0.4 AC1). ' +
      'Phụ huynh chưa đồng ý điều khoản hiện hành → 403 `CONSENT_REQUIRED` (`details.termsVersion`), áp dụng cho cả `/family/**` (US-0.3 AC2); user không có vai trò Phụ huynh → 403 `FORBIDDEN`.',
  })
  @ApiOkResponse({ standardSchema: familyStudentListSchema })
  students(@Ctx() ctx: RequestContext): Promise<FamilyStudentList> {
    return this.family.students(ctx.userId!);
  }

  @Get('students/:id/attendance')
  @ApiOperation({
    summary: 'Chuyên cần của con theo tuần (P02, US-0.3 AC4)',
    description:
      'Các buổi học của con trong một tuần kèm trạng thái điểm danh. `id` không phải con đã liên kết với user này (học viên khác, tenant khác, hay không tồn tại) → cùng 404 `NOT_FOUND`, không lộ học viên có tồn tại. ' +
      'Không trả ghi chú của giáo viên, liên hệ hay dữ liệu học viên khác. Không phân trang: một tuần có ít buổi. Chưa có endpoint riêng cho lịch học; danh sách `sessions` đã gồm cả buổi hủy và buổi bù (`isMakeup`).',
  })
  @ApiOkResponse({ standardSchema: familyAttendanceWeekSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  attendance(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) studentId: string,
    @Query({ schema: familyAttendanceQuerySchema })
    query: FamilyAttendanceQuery,
  ): Promise<FamilyAttendanceWeek> {
    return this.family.attendance(ctx.userId!, studentId, query.week);
  }

  @Post('absence-requests')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Phụ huynh báo con vắng trước một buổi (P02, US-3.4 AC1)',
    description:
      'Chỉ buổi CHƯA bắt đầu (`startsAt` > giờ máy chủ) và không hủy, của lớp con đang ghi danh. Con không liên kết với user này, buổi của tenant khác/không tồn tại, con không thuộc lớp của buổi → cùng 404 `NOT_FOUND` (không lộ tồn tại). ' +
      'Buổi đã bắt đầu → 409 `ABSENCE_SESSION_STARTED` (US-3.4 AC2); buổi đã hủy → 409 `SESSION_CANCELLED`. ' +
      'Con đã có báo vắng đang hiệu lực cho buổi này (kể cả do người giám hộ khác báo) → 200 trả đúng bản đang có, không tạo trùng, không thông báo lại; tạo mới → 201. Cùng `Idempotency-Key` trả lại đúng phản hồi cũ. ' +
      'Tạo mới đưa sự kiện outbox `student_absence_reported` để giáo viên nhận thông báo (US-3.4 AC1); loại `student_absence_reported` chưa khai vào `oneOf` của `Notification` (cùng ngoại lệ `oasdiff` chung với các loại mới khác), payload hộp thư `{ absenceRequestId, studentId, studentName, classId, className, sessionId, sessionStartsAt, reason }`. ' +
      'Điểm danh của buổi trả kèm `parentReport` để app giáo viên điền sẵn "Vắng có phép" (US-3.1 AC5). Chưa đồng ý điều khoản → 403 `CONSENT_REQUIRED`. Giới hạn 20 lần/phút/user.',
  })
  @ApiCreatedResponse({ standardSchema: absenceRequestSchema })
  @ApiOkResponse({
    standardSchema: absenceRequestSchema,
    description: 'Đã có báo vắng đang hiệu lực: trả bản đang có',
  })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'ABSENCE_SESSION_STARTED',
    'SESSION_CANCELLED',
    'RATE_LIMITED',
  )
  create(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createAbsenceRequestSchema }) body: CreateAbsenceRequest,
  ): Promise<AbsenceRequest> {
    return this.idem.run(req, reply, ctx, async (t) => {
      const r = await this.absences.create(t, ctx.userId!, body);
      return { status: r.created ? 201 : 200, body: r.request };
    });
  }

  @Get('absence-requests')
  @ApiOperation({
    summary: 'Báo vắng sắp tới của con (P02, US-3.4)',
    description:
      'Báo vắng đang hiệu lực của một con cho các buổi chưa bắt đầu, buổi gần nhất trước. `studentId` không phải con đã liên kết → 404 `NOT_FOUND`.',
  })
  @ApiOkResponse({ standardSchema: absenceRequestListSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  list(
    @Ctx() ctx: RequestContext,
    @Query({ schema: absenceRequestListQuerySchema })
    query: AbsenceRequestListQuery,
  ): Promise<AbsenceRequestList> {
    return this.absences.list(ctx.userId!, query.studentId);
  }

  @Delete('absence-requests/:id')
  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Phụ huynh hủy báo vắng trước (P02, US-3.4 AC3)',
    description:
      'Người giám hộ đã liên kết với con (không riêng người báo) hủy được trước giờ bắt đầu buổi: đặt `cancelled_at`, điểm danh không còn `parentReport`. Buổi đã bắt đầu → 409 `ABSENCE_SESSION_STARTED`. Id không phải báo vắng của con đã liên kết → 404 `NOT_FOUND`. ' +
      'Idempotent: gọi lại trên báo vắng đã hủy trả 204. Không thông báo lại cho giáo viên.',
  })
  @ApiNoContentResponse()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'ABSENCE_SESSION_STARTED',
    'RATE_LIMITED',
  )
  async cancel(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<void> {
    await this.absences.cancel(ctx.userId!, id);
  }
}
