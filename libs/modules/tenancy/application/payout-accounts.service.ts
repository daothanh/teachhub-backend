import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import { payoutAccounts, type Tx, users, writeAudit } from '@teachhub/db';
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

/** Chỉ trường đã che: số tài khoản đầy đủ không vào `audit_logs`. */
const auditView = (r: Row) => ({
  bankBin: r.bankBin,
  accountNoMasked: maskAccountNo(r.accountNo),
  accountName: r.accountName,
  isPrimary: r.isPrimary,
});

const needOtp = (): never => {
  throw new AppException('VALIDATION_FAILED', undefined, {
    otpCode: ['Thao tác này cần mã OTP.'],
  });
};

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
 * Mọi thay đổi ghi `audit_logs` (writeAudit) với số tài khoản đã che.
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
    ctx: { tenantId: string; userId: string; ip: string | undefined },
    body: CreatePayoutAccountRequest,
  ): Promise<PayoutAccount> {
    const existing = await this.lockAndLoad(tx, ctx.tenantId);
    if (existing.length >= MAX_PAYOUT_ACCOUNTS) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        _: [`Tối đa ${MAX_PAYOUT_ACCOUNTS} tài khoản nhận tiền.`],
      });
    }
    // Kiểm điều kiện chặn trước khi tiêu OTP: bị chặn thì mã còn dùng lại được.
    await this.verifyOtp(tx, ctx, body.otpCode);
    const isPrimary = existing.length === 0 || body.isPrimary === true;
    if (isPrimary) await this.clearPrimary(tx, ctx.tenantId, existing);
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
    await this.audit(tx, ctx.tenantId, row.id, 'insert', null, row);
    return toDto(row);
  }

  async update(
    tx: Tx,
    ctx: { tenantId: string; userId: string; ip: string | undefined },
    id: string,
    body: UpdatePayoutAccountRequest,
  ): Promise<PayoutAccount> {
    const rows = await this.lockAndLoad(tx, ctx.tenantId);
    const cur = rows.find((r) => r.id === id);
    if (!cur) throw new AppException('NOT_FOUND');
    const switching = body.isPrimary === true && !cur.isPrimary;
    const patch = {
      ...(body.bankBin !== undefined &&
        body.bankBin !== cur.bankBin && { bankBin: body.bankBin }),
      ...(body.accountNo !== undefined &&
        body.accountNo !== cur.accountNo && { accountNo: body.accountNo }),
      ...(body.accountName !== undefined &&
        body.accountName !== cur.accountName && {
          accountName: body.accountName,
        }),
      ...(switching && { isPrimary: true }),
    };
    // Không đổi gì: trả bản hiện tại, không ghi và không tiêu OTP.
    if (Object.keys(patch).length === 0) return toDto(cur);
    // Đổi nơi nhận tiền (số, ngân hàng, hoặc chuyển cờ chính sang tài khoản này) cần OTP.
    if ('bankBin' in patch || 'accountNo' in patch || switching) {
      if (!body.otpCode) needOtp();
      await this.verifyOtp(tx, ctx, body.otpCode!);
    }
    if (switching) await this.clearPrimary(tx, ctx.tenantId, rows);
    const [row] = await tx
      .update(payoutAccounts)
      .set(patch)
      .where(
        and(
          eq(payoutAccounts.tenantId, ctx.tenantId),
          eq(payoutAccounts.id, id),
        ),
      )
      .returning();
    await this.audit(tx, ctx.tenantId, id, 'update', cur, row!);
    return toDto(row!);
  }

  async remove(
    tx: Tx,
    ctx: { tenantId: string; userId: string; ip: string | undefined },
    id: string,
    otpCode: string | undefined,
  ): Promise<void> {
    const { tenantId } = ctx;
    const rows = await this.lockAndLoad(tx, tenantId);
    const cur = rows.find((r) => r.id === id);
    if (!cur) throw new AppException('NOT_FOUND');
    const next = rows.find((r) => r.id !== id);
    // Xóa tài khoản chính khi còn tài khoản khác = chuyển nơi nhận tiền sang tài khoản kia: cần OTP.
    if (cur.isPrimary && next) {
      if (!otpCode) needOtp();
      await this.verifyOtp(tx, ctx, otpCode!);
    }
    await tx
      .delete(payoutAccounts)
      .where(
        and(eq(payoutAccounts.tenantId, tenantId), eq(payoutAccounts.id, id)),
      );
    await this.audit(tx, tenantId, id, 'delete', cur, null);
    // Xóa tài khoản chính: tài khoản tạo sớm nhất còn lại lên thay.
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
      await this.audit(tx, tenantId, next.id, 'update', next, {
        ...next,
        isPrimary: true,
      });
    }
  }

  private audit(
    tx: Tx,
    tenantId: string,
    id: string,
    action: 'insert' | 'update' | 'delete',
    before: Row | null,
    after: Row | null,
  ): Promise<void> {
    return writeAudit(tx, {
      tenantId,
      entity: 'payout_accounts',
      entityId: id,
      action,
      before: before && auditView(before),
      after: after && auditView(after),
    });
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
  private async clearPrimary(
    tx: Tx,
    tenantId: string,
    rows: Row[],
  ): Promise<void> {
    const old = rows.find((r) => r.isPrimary);
    if (!old) return;
    await tx
      .update(payoutAccounts)
      .set({ isPrimary: false })
      .where(
        and(
          eq(payoutAccounts.tenantId, tenantId),
          eq(payoutAccounts.id, old.id),
        ),
      );
    await this.audit(tx, tenantId, old.id, 'update', old, {
      ...old,
      isPrimary: false,
    });
  }

  private async verifyOtp(
    tx: Tx,
    ctx: { userId: string; ip: string | undefined },
    code: string,
  ): Promise<void> {
    const [u] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ctx.userId));
    // Không có email thì không có hộp thư nhận OTP.
    if (!u?.email) throw new AppException('OTP_INVALID');
    await this.otp.verify(u.email, code, ctx.ip, 'payout_account');
  }
}
