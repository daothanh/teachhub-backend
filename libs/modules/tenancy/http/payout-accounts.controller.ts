import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type CreatePayoutAccountRequest,
  createPayoutAccountRequestSchema,
  type PayoutAccount,
  payoutAccountListSchema,
  type PayoutAccountList,
  payoutAccountSchema,
  type UpdatePayoutAccountRequest,
  updatePayoutAccountRequestSchema,
} from './payout-accounts.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 5 (S4-FL-10); thân hàm ở S5-BE-02. Chỉ `tenant_owner` ghi và đọc (Spec §4.8). Id của tenant khác → 404.
@ApiTags('payout-accounts')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('payout-accounts')
export class PayoutAccountsController {
  @Get()
  @ApiOperation({
    summary: 'Danh sách tài khoản nhận tiền (S5-FL-03)',
    description:
      'Tài khoản chính (`isPrimary`) đứng đầu. Chưa có tài khoản nào thì `items` rỗng: chốt kỳ sẽ bị chặn bằng 422 `PAYOUT_ACCOUNT_MISSING` (US-7.3 AC5).',
  })
  @ApiOkResponse({ standardSchema: payoutAccountListSchema })
  list(): PayoutAccountList {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post()
  @ApiOperation({
    summary: 'Thêm tài khoản nhận tiền',
    description:
      'Tài khoản đầu tiên tự là tài khoản chính. `isPrimary = true` ở tài khoản sau chuyển cờ chính sang tài khoản này trong cùng giao dịch. Tối đa 5 tài khoản mỗi tenant, vượt → 422 `VALIDATION_FAILED`. ' +
      'Hóa đơn dùng tài khoản chính lúc phát hành và chụp lại vào hóa đơn (`payout`), nên sửa hay xóa tài khoản sau đó không đổi hóa đơn đã phát hành.',
  })
  @ApiCreatedResponse({ standardSchema: payoutAccountSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'CONFLICT_STALE')
  create(
    @Body({ schema: createPayoutAccountRequestSchema })
    _body: CreatePayoutAccountRequest,
  ): PayoutAccount {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Sửa tài khoản nhận tiền',
    description:
      'Chỉ gửi trường đổi. `isPrimary` chỉ nhận `true` (đặt làm chính). Không ảnh hưởng hóa đơn đã phát hành.',
  })
  @ApiOkResponse({ standardSchema: payoutAccountSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  update(
    @Param('id', { schema: idParam }) _id: string,
    @Body({ schema: updatePayoutAccountRequestSchema })
    _body: UpdatePayoutAccountRequest,
  ): PayoutAccount {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Xóa tài khoản nhận tiền',
    description:
      'Xóa tài khoản chính khi còn tài khoản khác thì tài khoản tạo sớm nhất còn lại thành chính. Xóa tài khoản cuối cùng cho phép: lần chốt kỳ sau bị chặn bằng 422 `PAYOUT_ACCOUNT_MISSING`. Gọi lại trên tài khoản đã xóa → 404.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey()
  @ApiErrors('NOT_FOUND')
  remove(@Param('id', { schema: idParam }) _id: string): void {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
