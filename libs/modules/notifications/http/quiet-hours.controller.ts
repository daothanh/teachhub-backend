import { Body, Controller, Get, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, Ctx, type RequestContext } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { RequiresRole } from '@teachhub/modules/identity';
import { QuietHoursService } from '../application/quiet-hours.service.js';
import {
  type QuietHours,
  quietHoursSchema,
  type UpdateQuietHoursRequest,
  updateQuietHoursRequestSchema,
} from './quiet-hours.schemas.js';

// US-6.5. Chỉ `tenant_owner`. `PUT` tự lặp được (đặt giá trị) nên không cần `Idempotency-Key`, như `tenant/settings/dunning`.
@ApiTags('notifications')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class QuietHoursController {
  constructor(
    private readonly tx: TxService,
    private readonly quiet: QuietHoursService,
  ) {}

  @Get('tenant/settings/quiet-hours')
  @ApiOperation({
    summary: 'Xem giờ yên lặng của tenant (US-6.5)',
    description:
      'Tenant chưa chỉnh lần nào trả mặc định `21:30` đến `07:00` (giờ tenant).',
  })
  @ApiOkResponse({ standardSchema: quietHoursSchema })
  get(@Ctx() ctx: RequestContext): Promise<QuietHours> {
    return this.tx.run(ctx, (t) => this.quiet.get(t, ctx.tenantId!));
  }

  @Put('tenant/settings/quiet-hours')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Đổi giờ yên lặng của tenant (US-6.5 AC3)',
    description:
      'Thay toàn bộ khung, áp cho cả tenant. Tin không khẩn đã hoãn trước đó giữ mốc gửi cũ; chỉ tin phát sinh sau khi lưu theo khung mới. `start` và `end` dạng `HH:MM` (00:00 đến 23:59), không trùng nhau; `end` nhỏ hơn `start` là khung qua nửa đêm. Sai → 422 `VALIDATION_FAILED`. Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`).',
  })
  @ApiOkResponse({ standardSchema: quietHoursSchema })
  @ApiErrors('VALIDATION_FAILED', 'RATE_LIMITED')
  put(
    @Ctx() ctx: RequestContext,
    @Body({ schema: updateQuietHoursRequestSchema })
    body: UpdateQuietHoursRequest,
  ): Promise<QuietHours> {
    return this.tx.run(ctx, (t) =>
      this.quiet.put(t, ctx.tenantId!, { start: body.start, end: body.end }),
    );
  }
}
