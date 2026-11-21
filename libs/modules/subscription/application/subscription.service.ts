import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import { AppException, type Env, uuidv7 } from '@teachhub/core';
import { bankTransferOrders, type Tx } from '@teachhub/db';
import { buildVietQrPayload } from '@teachhub/modules/billing';
import type {
  PlanUsage,
  SubscriptionBankTransferOrder,
} from '../http/subscription.schemas.js';
import { PlanService, toOrder } from './plan.service.js';

const NOTE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// "TH PRO " + 6 ký tự: 13 ký tự, khớp `[A-Z0-9 ]{1,25}`; quản trị đối chiếu theo nội dung này.
const newTransferNote = () =>
  'TH PRO ' +
  Array.from(
    { length: 6 },
    () => NOTE_ALPHABET[randomInt(NOTE_ALPHABET.length)],
  ).join('');

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly plans: PlanService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Dùng thử Pro 14 ngày, một lần mỗi tenant (US-0.8 AC1). Quyết định nguyên tử trong `app_private.start_trial`. */
  async startTrial(tx: Tx, ctx: { tenantId: string }): Promise<PlanUsage> {
    const res = await tx.execute<{ r: string }>(
      sql`select app_private.start_trial(${ctx.tenantId}::uuid) as r`,
    );
    const r = res.rows[0]?.r;
    if (r === 'conflict') throw new AppException('CONFLICT_STALE');
    if (r === 'trial_used') throw new AppException('TRIAL_ALREADY_USED');
    return this.plans.usage(tx, ctx.tenantId);
  }

  /** Đơn chuyển khoản Pro (US-0.8 AC3, chỉ web). Đã có đơn `pending` → trả lại đơn đó. */
  async createBankTransferOrder(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
  ): Promise<SubscriptionBankTransferOrder> {
    const [existing] = await tx
      .select()
      .from(bankTransferOrders)
      .where(
        and(
          eq(bankTransferOrders.tenantId, ctx.tenantId),
          eq(bankTransferOrders.status, 'pending'),
        ),
      );
    if (existing) return toOrder(existing);

    const amount = this.config.get('PRO_PRICE_VND');
    const bankBin = this.config.get('PAYEE_BANK_BIN');
    const accountNo = this.config.get('PAYEE_ACCOUNT_NO');
    const accountName = this.config.get('PAYEE_ACCOUNT_NAME');
    // Chưa cấu hình giá/tài khoản nhận: không bịa đơn.
    if (!amount || !bankBin || !accountNo || !accountName)
      throw new AppException('SERVICE_UNAVAILABLE');
    const transferNote = newTransferNote();
    const payee = {
      bankBin,
      bankName: this.config.get('PAYEE_BANK_NAME') ?? null,
      accountNo,
      accountName,
    };
    const [row] = await tx
      .insert(bankTransferOrders)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        planCode: 'pro',
        amount,
        transferNote,
        payee,
        qrPayload: buildVietQrPayload({
          bankBin,
          accountNo,
          amount,
          transferNote,
        }),
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return toOrder(row);
    // Request song song vừa tạo xong (unique đơn pending của tenant): trả bản đó.
    const [raced] = await tx
      .select()
      .from(bankTransferOrders)
      .where(
        and(
          eq(bankTransferOrders.tenantId, ctx.tenantId),
          eq(bankTransferOrders.status, 'pending'),
        ),
      );
    return toOrder(raced!);
  }
}
