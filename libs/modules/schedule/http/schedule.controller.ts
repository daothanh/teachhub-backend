import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
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
  AppException,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { ScheduleService } from '../application/schedule.service.js';
import {
  type CancelSessionRequest,
  cancelSessionRequestSchema,
  type MakeupSessionRequest,
  makeupSessionRequestSchema,
  type PutScheduleRulesRequest,
  putScheduleRulesRequestSchema,
  type RescheduleSessionRequest,
  rescheduleSessionRequestSchema,
  type ScheduleRulesResult,
  scheduleRulesResultSchema,
  type Session,
  sessionSchema,
  type SessionsQuery,
  sessionsQuerySchema,
  type SessionsResponse,
  sessionsResponseSchema,
} from './schedule.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 2 (S1-CT-02); S2-BE-08. Dời/hủy/bù: bổ sung Sprint 4 (S3-FL-12), thân hàm ở S4-BE-07.
@ApiTags('schedule')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class ScheduleController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly schedule: ScheduleService,
  ) {}

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
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: putScheduleRulesRequestSchema })
    body: PutScheduleRulesRequest,
  ): Promise<ScheduleRulesResult> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.schedule.putRules(t, ctx.tenantId!, id, body),
    }));
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
    @Ctx() ctx: RequestContext,
    @Query({ schema: sessionsQuerySchema }) query: SessionsQuery,
  ): Promise<SessionsResponse> {
    return this.tx.run(ctx, (t) => this.schedule.list(t, ctx.tenantId!, query));
  }

  @Post('sessions/:id/reschedule')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dời buổi học (US-2.2 AC1)',
    description:
      'Chỉ buổi `planned`: buổi đã dạy → 409 `CONFLICT_STALE`, buổi đã hủy → 409 `SESSION_CANCELLED`. `startsAt` ở quá khứ → 422 `VALIDATION_FAILED`. ' +
      'Ghi `schedule_changed` vào outbox, phụ huynh của lớp nhận thông báo (loại `schedule_changed`, `change = rescheduled`) trong ≤ 1 phút. Buổi của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: sessionSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'CONFLICT_STALE',
    'SESSION_CANCELLED',
  )
  reschedule(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: rescheduleSessionRequestSchema })
    _body: RescheduleSessionRequest,
  ): Session {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('sessions/:id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hủy buổi học (US-2.2 AC2)',
    description:
      'Buổi đã có điểm danh (kể cả buổi đã dạy) → 409 `SESSION_HAS_ATTENDANCE`: app phải hướng dẫn giáo viên sửa điểm danh trước rồi mới hủy, không tự xóa điểm danh. ' +
      'Hủy buổi đã hủy → 200 với buổi hiện tại (idempotent, không gửi thông báo lần hai). Ghi `schedule_changed` (`change = cancelled`) vào outbox, phụ huynh của lớp nhận thông báo ≤ 1 phút. Buổi của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: sessionSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'SESSION_HAS_ATTENDANCE')
  cancel(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: cancelSessionRequestSchema }) _body: CancelSessionRequest,
  ): Session {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('sessions/:id/makeup')
  @ApiOperation({
    summary: 'Tạo buổi bù cho buổi đã hủy (US-2.2 AC4)',
    description:
      '`id` là buổi gốc, phải đang `cancelled` (khác → 409 `CONFLICT_STALE`); mỗi buổi gốc có tối đa một buổi bù. Trả buổi mới `isMakeup = true`, `makeupOf = id`, cùng lớp và thời lượng gốc nếu không gửi `durationMin`. ' +
      'Ghi `schedule_changed` (`change = makeup`) vào outbox. AC3 (không tính thêm tiền) kiểm ở `billing`, Sprint 5.',
  })
  @ApiCreatedResponse({ standardSchema: sessionSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE')
  makeup(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: makeupSessionRequestSchema }) _body: MakeupSessionRequest,
  ): Session {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
