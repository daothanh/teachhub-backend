import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { ScheduleService } from '../application/schedule.service.js';
import {
  type PutScheduleRulesRequest,
  putScheduleRulesRequestSchema,
  type ScheduleRulesResult,
  scheduleRulesResultSchema,
  type SessionsQuery,
  sessionsQuerySchema,
  type SessionsResponse,
  sessionsResponseSchema,
} from './schedule.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 2 (S1-CT-02); S2-BE-08.
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
}
