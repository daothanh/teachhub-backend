import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
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
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { NotificationsService } from '../application/notifications.service.js';
import {
  type MarkReadRequest,
  markReadRequestSchema,
  type MarkReadResult,
  markReadResultSchema,
  type NotificationsQuery,
  notificationsQuerySchema,
  type NotificationsResponse,
  notificationsResponseSchema,
} from './notifications.schemas.js';

// Hợp đồng Sprint 3 (S2-FL-10); thân hàm ở task backend thông báo (S3-BE-06 trở đi).
@ApiTags('notifications')
@ApiBearerAuth('bearer')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly service: NotificationsService,
  ) {}

  private user(ctx: RequestContext): string {
    if (!ctx.userId) throw new AppException('UNAUTHENTICATED');
    return ctx.userId;
  }

  @Get()
  @ApiOperation({
    summary: 'Hộp thông báo của vai trò đang mở (US-6.1)',
    description:
      'Phân trang con trỏ (Spec §5.5), mới nhất trước. Chỉ trả thông báo gửi cho chính user và đúng vai trò `active-membership`; không bao giờ lộ thông báo của người khác. ' +
      'Từ Sprint 4 có thêm loại `schedule_changed` (US-2.2) mà schema chưa liệt kê vì oasdiff coi thêm `oneOf` là breaking; client bỏ qua `type` lạ. Hình dạng: `payload = { classId, className, sessionId, change (rescheduled|cancelled|makeup), sessionStartsAt, previousStartsAt|null, reason|null }`, `deepLink = teachhub://sessions/{sessionId}`. ' +
      'Từ Sprint 5 có thêm hai loại cũng chưa liệt kê vì lý do trên: `billing_ready` (cho giáo viên, `payload = { periodId, periodMonth, draftCount, draftTotalAmount }`, `deepLink = teachhub://billing/periods/{periodId}`) và `invoice_issued` (cho phụ huynh, `payload = { invoiceId, studentId, studentName, periodMonth, totalAmount, dueDate }`, `deepLink = teachhub://invoices/{invoiceId}`). Push của hai loại này có chữ khay chung theo loại, `data` chỉ `notificationId`, `type`: không tên con, không số tiền; email `invoice_issued` có tiêu đề cố định, không chứa tên con. ' +
      'Từ Sprint 6 thêm hai loại cho phụ huynh, cũng chưa liệt kê: `payment_recorded` (`payload = { invoiceId, paymentId, studentId, studentName, amount, paidOn, status (partially_paid|paid), remainingAmount }`, `deepLink = teachhub://invoices/{invoiceId}`) và `payment_reminder` (nhắc nợ, `payload = { invoiceId, studentId, studentName, offsetDays, remainingAmount, dueDate }`, cùng deepLink); push có chữ khay chung theo loại, không tên con, không số tiền.',
  })
  @ApiOkResponse({ standardSchema: notificationsResponseSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Ctx() ctx: RequestContext,
    @Query({ schema: notificationsQuerySchema }) query: NotificationsQuery,
  ): Promise<NotificationsResponse> {
    const userId = this.user(ctx);
    return this.tx.run({ userId }, (t) => this.service.list(t, userId, query));
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Đánh dấu đã đọc (US-6.1)',
    description:
      'Id trùng trong danh sách chỉ tính một lần. Id của người khác và id không tồn tại không phân biệt: đều bị bỏ qua, không báo lỗi (không dò được id của người khác); id đã đọc cũng bỏ qua.',
  })
  @ApiOkResponse({ standardSchema: markReadResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  read(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: markReadRequestSchema }) body: MarkReadRequest,
  ): Promise<MarkReadResult> {
    const userId = this.user(ctx);
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.service.markRead(t, userId, body.ids),
    }));
  }
}
