import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, Ctx, type RequestContext } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { RequiresRole } from '@teachhub/modules/identity';
import { DunningService } from '../application/dunning.service.js';
import {
  type DunningPreview,
  type DunningPreviewQuery,
  dunningPreviewQuerySchema,
  dunningPreviewSchema,
  type DunningSettings,
  dunningSettingsSchema,
  type EnrollmentDunningResult,
  enrollmentDunningResultSchema,
  type InvoiceDunning,
  invoiceDunningSchema,
  type PutEnrollmentDunningRequest,
  putEnrollmentDunningRequestSchema,
  type UpdateDunningSettingsRequest,
  updateDunningSettingsRequestSchema,
} from './dunning.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 6 (S5-FL-09, S5-CT-01); S6-BE-04. Chỉ `tenant_owner`. Id của tenant khác → 404.
// Các `PUT` tự lặp được (đặt giá trị) nên không cần `Idempotency-Key`.
@ApiTags('billing')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class DunningController {
  constructor(
    private readonly tx: TxService,
    private readonly dunning: DunningService,
  ) {}

  @Get('tenant/settings/dunning')
  @ApiOperation({
    summary: 'Xem cài đặt nhắc nợ của tenant (US-7.5 AC4)',
    description:
      'Công tắc chung và lịch mốc nhắc. Tenant chưa chỉnh lần nào trả mặc định `enabled = true`, `offsetsDays = [-1, 0, 3, 7]` (US-7.5 AC1).',
  })
  @ApiOkResponse({ standardSchema: dunningSettingsSchema })
  getSettings(@Ctx() ctx: RequestContext): Promise<DunningSettings> {
    return this.tx.run(ctx, (t) => this.dunning.getSettings(t, ctx.tenantId!));
  }

  @Put('tenant/settings/dunning')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Đổi cài đặt nhắc nợ của tenant (US-7.5 AC4)',
    description:
      'Thay toàn bộ cài đặt. Lịch mới chỉ áp cho hóa đơn phát hành sau khi lưu. Tắt `enabled` thì hủy lời nhắc chưa gửi của mọi hóa đơn đang mở; bật lại không lập lại cho hóa đơn cũ. `offsetsDays` không hợp lệ (trùng, không tăng dần, ngoài -7 đến 30, quá 6 mốc) → 422 `VALIDATION_FAILED`. Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`).',
  })
  @ApiOkResponse({ standardSchema: dunningSettingsSchema })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  putSettings(
    @Ctx() ctx: RequestContext,
    @Body({ schema: updateDunningSettingsRequestSchema })
    body: UpdateDunningSettingsRequest,
  ): Promise<DunningSettings> {
    return this.tx.run(ctx, (t) =>
      this.dunning.putSettings(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        body,
      ),
    );
  }

  @Get('tenant/settings/dunning/preview')
  @ApiOperation({
    summary: 'Xem trước mẫu tin nhắc nợ của một mốc (US-7.5 AC4)',
    description:
      'Dựng tin mẫu bằng dữ liệu giả để giáo viên xem giọng văn trước khi đổi lịch; không gửi gì cho ai. Tin thật do hệ thống đứng tên "TeachHub nhắc…", có số còn nợ, hạn và nút mở hóa đơn.',
  })
  @ApiOkResponse({ standardSchema: dunningPreviewSchema })
  @ApiErrors('VALIDATION_FAILED')
  preview(
    @Query({ schema: dunningPreviewQuerySchema })
    query: DunningPreviewQuery,
  ): DunningPreview {
    return this.dunning.preview(query);
  }

  @Put('enrollments/:id/dunning')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Bật hoặc tắt nhắc nợ theo học viên (US-7.5 AC3)',
    description:
      'Đặt `enrollments.dunning_enabled` của một ghi danh. Tắt: hủy mọi lời nhắc chưa gửi của các hóa đơn còn nợ của học viên đó (`cancelledCount`) nếu học viên không còn ghi danh đang mở nào bật nhắc; bật lại: lập lại các mốc chưa tới của hóa đơn còn nợ. Hóa đơn gộp mọi lớp của học viên nên app bật/tắt theo học viên bằng cách gọi cho từng ghi danh đang mở (danh sách ở `GET /receivables/{studentId}`). ' +
      'Ghi danh đã rời lớp (`leftOn`) → 409 `CONFLICT_STALE`; ghi danh của tenant khác → 404. Gọi lặp cùng giá trị → 200, `cancelledCount = 0`, không đổi gì. Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`).',
  })
  @ApiOkResponse({ standardSchema: enrollmentDunningResultSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE', 'RATE_LIMITED')
  putEnrollment(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: putEnrollmentDunningRequestSchema })
    body: PutEnrollmentDunningRequest,
  ): Promise<EnrollmentDunningResult> {
    return this.tx.run(ctx, (t) =>
      this.dunning.setEnrollment(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body.enabled,
      ),
    );
  }

  @Get('invoices/:id/dunning')
  @ApiOperation({
    summary: 'Trạng thái nhắc nợ của hóa đơn (US-7.5)',
    description:
      'Các mốc đã lập (`pending`, `sent`, `cancelled`) và lý do khi không còn nhắc (`disabledReason`). Bản nháp và hóa đơn 0 đ trả `steps` rỗng. Hóa đơn của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: invoiceDunningSchema })
  @ApiErrors('NOT_FOUND')
  invoice(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<InvoiceDunning> {
    return this.tx.run(ctx, (t) =>
      this.dunning.forInvoice(t, ctx.tenantId!, id),
    );
  }
}
