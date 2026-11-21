import { Body, Controller, Param, Put, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { EnrollmentsService } from '../application/enrollments.service.js';
import {
  type FeeOverrideResult,
  feeOverrideResultSchema,
  type PutFeeOverrideRequest,
  putFeeOverrideRequestSchema,
} from './classes.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 5 (S4-FL-10); S5-BE-02.
@ApiTags('classes')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('enrollments')
export class EnrollmentFeesController {
  constructor(
    private readonly idem: Idempotency,
    private readonly enrollments: EnrollmentsService,
  ) {}

  @Put(':id/fee-override')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Đặt mức riêng, quy tắc vắng riêng, miễn giảm cho học viên (US-1.3)',
    description:
      'Thay toàn bộ mức riêng của một ghi danh; thứ tự áp dụng học sinh > lớp > mặc định (US-1.3 AC1). Mức riêng chỉ áp dụng từ kỳ chưa chốt tiếp theo, hóa đơn đã phát hành không đổi. ' +
      'Có mức riêng (kể cả chỉ miễn giảm) thì `GET /classes/{id}/roster` trả `feeOverride` khác null để hiện nhãn "Giá riêng" (US-1.3 AC2). Miễn giảm 100% → hóa đơn 0 đ không được gửi và không nhắc nợ (AC3). ' +
      'Tối đa 5 khoản `discounts`, mỗi khoản có `description`; `installments` chỉ hợp lệ với lớp trọn khóa (vượt → 422). Giới hạn 20 lần/phút/IP (429 `RATE_LIMITED`). ' +
      '`feeAmount` đòi lớp đã có học phí, nếu không → 422 `VALIDATION_FAILED`. Ghi danh đã rời lớp (`leftOn`) → 409 `CONFLICT_STALE`; ghi danh của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: feeOverrideResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE', 'RATE_LIMITED')
  put(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) enrollmentId: string,
    @Body({ schema: putFeeOverrideRequestSchema }) body: PutFeeOverrideRequest,
  ): Promise<FeeOverrideResult> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.enrollments.putFeeOverride(
        t,
        ctx.tenantId!,
        enrollmentId,
        body,
      ),
    }));
  }
}
