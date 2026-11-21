import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import { payoutAccounts, type Tx, users } from '@teachhub/db';
import { OtpService } from '@teachhub/modules/auth';
import {
  MAX_PAYOUT_ACCOUNTS,
  maskAccountNo,
} from '../domain/payout-account.js';
import type {
  CreatePayoutAccountRequest,
  PayoutAccount,
  PayoutAccountList,
  UpdatePayoutAccountRequest,
} from '../http/payout-accounts.schemas.js';

type Row = typeof payoutAccounts.$inferSelect;

const toDto = (r: Row): PayoutAccount => ({
  id: r.id,
  bankBin: r.bankBin,
  accountNoMasked: maskAccountNo(r.accountNo),
  accountName: r.accountName,
  isPrimary: r.isPrimary,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Tài khoản nhận tiền của tenant (S5-BE-02). Lọc `tenant_id` tường minh, RLS (`payout_accounts_staff_all`) là lớp thứ hai;
 * id của tenant khác → không thấy dòng → NOT_FOUND. Số tài khoản đầy đủ không trả ra ngoài.
 * shortcut: chưa ghi audit_logs (role app không có quyền ghi, cần hàm security definer ở migration mới).
 */
@Injectable()
export class PayoutAccountsService {
  constructor(private readonly otp: OtpService) {}

  async list(tx: Tx, tenantId: string): Promise<PayoutAccountList> {
    const rows = await tx
      .select()
      .from(payoutAccounts)
      .where(eq(payoutAccounts.tenantId, tenantId))
      .orderBy(
        desc(payoutAccounts.isPrimary),
        asc(payoutAccounts.createdAt),
        asc(payoutAccounts.id),
      );
    return { items: rows.map(toDto) };
  }

  async create(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    body: CreatePayoutAccountRequest,
  ): Promise<PayoutAccount> {
    const existing = await this.lockAndLoad(tx, ctx.tenantId);
    if (existing.length >= MAX_PAYOUT_ACCOUNTS) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        _: [`Tối đa ${MAX_PAYOUT_ACCOUNTS} tài khoản nhận tiền.`],
      });
    }
    // Kiểm điều kiện chặn trước khi tiêu OTP: bị chặn thì mã còn dùng lại được.
    await this.verifyOtp(tx, ctx.userId, body.otpCode);
    const isPrimary = existing.length === 0 || body.isPrimary === true;
    if (isPrimary) await this.clearPrimary(tx, ctx.tenantId);
    const [row] = await tx
      .insert(payoutAccounts)
      .values({
        id: body.id ?? uuidv7(),
        tenantId: ctx.tenantId,
        bankBin: body.bankBin,
        accountNo: body.accountNo,
        accountName: body.accountName,
        isPrimary,
      })
      .onConflictDoNothing()
      .returning();
    // `id` do client gửi đã có (kể cả ở tenant khác): không tiết lộ, coi như dữ liệu cũ.
    if (!row) throw new AppException('CONFLICT_STALE');
    return toDto(row);
  }

  async update(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    id: string,
    body: UpdatePayoutAccountRequest,
  ): Promise<PayoutAccount> {
    const rows = await this.lockAndLoad(tx, ctx.tenantId);
    const cur = rows.find((r) => r.id === id);
    if (!cur) throw new AppException('NOT_FOUND');
    if (body.bankBin !== undefined || body.accountNo !== undefined) {
      await this.verifyOtp(tx, ctx.userId, body.otpCode!);
    }
    if (body.isPrimary && !cur.isPrimary) {
      await this.clearPrimary(tx, ctx.tenantId);
    }
    const [row] = await tx
      .update(payoutAccounts)
      .set({
        ...(body.bankBin !== undefined && { bankBin: body.bankBin }),
        ...(body.accountNo !== undefined && { accountNo: body.accountNo }),
        ...(body.accountName !== undefined && {
          accountName: body.accountName,
        }),
        ...(body.isPrimary && { isPrimary: true }),
      })
      .where(
        and(
          eq(payoutAccounts.tenantId, ctx.tenantId),
          eq(payoutAccounts.id, id),
        ),
      )
      .returning();
    return toDto(row!);
  }

  async remove(tx: Tx, tenantId: string, id: string): Promise<void> {
    const rows = await this.lockAndLoad(tx, tenantId);
    const cur = rows.find((r) => r.id === id);
    if (!cur) throw new AppException('NOT_FOUND');
    await tx
      .delete(payoutAccounts)
      .where(
        and(eq(payoutAccounts.tenantId, tenantId), eq(payoutAccounts.id, id)),
      );
    // Xóa tài khoản chính: tài khoản tạo sớm nhất còn lại lên thay.
    const next = rows.find((r) => r.id !== id);
    if (cur.isPrimary && next) {
      await tx
        .update(payoutAccounts)
        .set({ isPrimary: true })
        .where(
          and(
            eq(payoutAccounts.tenantId, tenantId),
            eq(payoutAccounts.id, next.id),
          ),
        );
    }
  }

  /** Khóa theo tenant (ghi song song cùng tenant xếp hàng) rồi đọc các tài khoản, cũ nhất trước. */
  private async lockAndLoad(tx: Tx, tenantId: string): Promise<Row[]> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`payout_accounts:${tenantId}`}, 0))`,
    );
    return tx
      .select()
      .from(payoutAccounts)
      .where(eq(payoutAccounts.tenantId, tenantId))
      .orderBy(asc(payoutAccounts.createdAt), asc(payoutAccounts.id));
  }

  /** Unique partial `payout_accounts_primary_uq`: phải bỏ cờ cũ trước khi đặt cờ mới. */
  private async clearPrimary(tx: Tx, tenantId: string): Promise<void> {
    await tx
      .update(payoutAccounts)
      .set({ isPrimary: false })
      .where(
        and(
          eq(payoutAccounts.tenantId, tenantId),
          eq(payoutAccounts.isPrimary, true),
        ),
      );
  }

  private async verifyOtp(tx: Tx, userId: string, code: string): Promise<void> {
    const [u] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    // Không có email thì không có hộp thư nhận OTP.
    if (!u?.email) throw new AppException('OTP_INVALID');
    await this.otp.verify(u.email, code, 'payout_account');
  }
}
