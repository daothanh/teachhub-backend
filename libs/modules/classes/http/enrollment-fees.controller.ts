import { Body, Controller, Param, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type FeeOverrideResult,
  feeOverrideResultSchema,
  type PutFeeOverrideRequest,
  putFeeOverrideRequestSchema,
} from './classes.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 5 (S4-FL-10); thân hàm ở S5-BE-02.
@ApiTags('classes')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('enrollments')
export class EnrollmentFeesController {
  @Put(':id/fee-override')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Đặt mức riêng, quy tắc vắng riêng, miễn giảm cho học viên (US-1.3)',
    description:
      'Thay toàn bộ mức riêng của một ghi danh; thứ tự áp dụng học sinh > lớp > mặc định (US-1.3 AC1). Mức riêng chỉ áp dụng từ kỳ chưa chốt tiếp theo, hóa đơn đã phát hành không đổi. ' +
      'Có mức riêng (kể cả chỉ miễn giảm) thì `GET /classes/{id}/roster` trả `feeOverride` khác null để hiện nhãn "Giá riêng" (US-1.3 AC2). Miễn giảm 100% → hóa đơn 0 đ không được gửi và không nhắc nợ (AC3). ' +
      'Tối đa 5 khoản `discounts`, mỗi khoản có `description`; `installments` chỉ hợp lệ với lớp trọn khóa (vượt → 422). Giới hạn 20 lần/phút/user (429 `RATE_LIMITED`). ' +
      '`feeAmount` đòi lớp đã có học phí, nếu không → 422 `VALIDATION_FAILED`. Ghi danh đã rời lớp (`leftOn`) → 409 `CONFLICT_STALE`; ghi danh của tenant khác → 404.',
  })
  @ApiOkResponse({ standardSchema: feeOverrideResultSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE', 'RATE_LIMITED')
  put(
    @Param('id', { schema: idParam }) _enrollmentId: string,
    @Body({ schema: putFeeOverrideRequestSchema }) _body: PutFeeOverrideRequest,
  ): FeeOverrideResult {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
