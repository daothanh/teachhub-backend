import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { TxService } from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { PayoutAccountsService } from '../application/payout-accounts.service.js';
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

// Hợp đồng Sprint 5 (S4-FL-10); S5-BE-02. Chỉ `tenant_owner` ghi và đọc (Spec §4.8). Id của tenant khác → 404.
@ApiTags('payout-accounts')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('payout-accounts')
export class PayoutAccountsController {
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly accounts: PayoutAccountsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Danh sách tài khoản nhận tiền (S5-FL-03)',
    description:
      'Tài khoản chính (`isPrimary`) đứng đầu, số tài khoản đã che (`accountNoMasked`). Chưa có tài khoản nào thì `items` rỗng: chốt kỳ sẽ bị chặn bằng 422 `PAYOUT_ACCOUNT_MISSING` (US-7.3 AC5).',
  })
  @ApiOkResponse({ standardSchema: payoutAccountListSchema })
  list(@Ctx() ctx: RequestContext): Promise<PayoutAccountList> {
    return this.tx.run(ctx, (t) => this.accounts.list(t, ctx.tenantId!));
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Thêm tài khoản nhận tiền',
    description:
      'Tài khoản đầu tiên tự là tài khoản chính. `isPrimary = true` ở tài khoản sau chuyển cờ chính sang tài khoản này trong cùng giao dịch. Tối đa 5 tài khoản mỗi tenant, vượt → 422 `VALIDATION_FAILED`. Cần `otpCode` (xem mô tả trường). Ghi tối đa 20 lần/phút/user (429 `RATE_LIMITED`). ' +
      'Hóa đơn dùng tài khoản chính lúc phát hành và chụp lại vào hóa đơn (`payout`), nên sửa hay xóa tài khoản sau đó không đổi hóa đơn đã phát hành.',
  })
  @ApiCreatedResponse({ standardSchema: payoutAccountSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'OTP_INVALID', 'OTP_LOCKED', 'RATE_LIMITED')
  create(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: createPayoutAccountRequestSchema })
    body: CreatePayoutAccountRequest,
  ): Promise<PayoutAccount> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.accounts.create(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        body,
      ),
    }));
  }

  @Patch(':id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Sửa tài khoản nhận tiền',
    description:
      'Chỉ gửi trường đổi. `isPrimary` chỉ nhận `true` (đặt làm chính). Đổi `bankBin` hoặc `accountNo` bắt buộc `otpCode`, thiếu → 422 `VALIDATION_FAILED`. Không ảnh hưởng hóa đơn đã phát hành.',
  })
  @ApiOkResponse({ standardSchema: payoutAccountSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'OTP_INVALID',
    'OTP_LOCKED',
    'RATE_LIMITED',
  )
  update(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updatePayoutAccountRequestSchema })
    body: UpdatePayoutAccountRequest,
  ): Promise<PayoutAccount> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 200,
      body: await this.accounts.update(
        t,
        { tenantId: ctx.tenantId!, userId: ctx.userId! },
        id,
        body,
      ),
    }));
  }

  @Delete(':id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Xóa tài khoản nhận tiền',
    description:
      'Xóa tài khoản chính khi còn tài khoản khác thì tài khoản tạo sớm nhất còn lại thành chính. Xóa tài khoản cuối cùng cho phép: lần chốt kỳ sau bị chặn bằng 422 `PAYOUT_ACCOUNT_MISSING`. Gọi lại trên tài khoản đã xóa → 404.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey()
  @ApiErrors('NOT_FOUND', 'RATE_LIMITED')
  async remove(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<void> {
    await this.idem.run(req, reply, ctx, async (t) => ({
      status: 204,
      body: await this.accounts.remove(t, ctx.tenantId!, id),
    }));
  }
}
