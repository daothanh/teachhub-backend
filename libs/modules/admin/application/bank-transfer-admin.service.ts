import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '@teachhub/core';
import { TxService, type Tx } from '@teachhub/db';
import type {
  BankTransferConfirmed,
  BankTransferListQuery,
  BankTransferOrder,
  BankTransferOrderPage,
  ConfirmBankTransferRequest,
} from '../http/admin.schemas.js';

interface RawOrder {
  id: string;
  tenantId: string;
  tenantName: string;
  amount: number;
  transferNote: string;
  status: 'pending' | 'confirmed';
  createdAtMs: number;
  confirmedBy: string | null;
  confirmedAtMs: number | null;
  bankTransactionRef: string | null;
  updatedAtMs: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const toOrder = (r: RawOrder): BankTransferOrder => ({
  id: r.id,
  tenantId: r.tenantId,
  tenantName: r.tenantName,
  amount: r.amount,
  transferNote: r.transferNote,
  status: r.status,
  createdAt: iso(r.createdAtMs),
  confirmedBy: r.confirmedBy,
  confirmedAt: r.confirmedAtMs === null ? null : iso(r.confirmedAtMs),
  bankTransactionRef: r.bankTransactionRef,
  updatedAt: iso(r.updatedAtMs),
});

/**
 * Xác nhận chuyển khoản gói Pro (US-0.8 AC3). Admin không có user/tenant nên chỉ đi qua hàm security definer
 * `app_private.admin_*` (cờ phiên `app.admin` + `app.admin_user` đặt ở đây, sau khi `AdminGuard` đã kiểm secret và quyền).
 */
@Injectable()
export class BankTransferAdminService {
  constructor(private readonly tx: TxService) {}

  private run<T>(adminUserId: string, fn: (t: Tx) => Promise<T>): Promise<T> {
    return this.tx.run({ userId: null }, async (t) => {
      await t.execute(sql`select set_config('app.admin', '1', true)`);
      await t.execute(
        sql`select set_config('app.admin_user', ${adminUserId}, true)`,
      );
      return fn(t);
    });
  }

  list(
    adminUserId: string,
    q: BankTransferListQuery,
  ): Promise<BankTransferOrderPage> {
    return this.run(adminUserId, async (t) => {
      const r = await t.execute<{ r: { total: number; items: RawOrder[] } }>(
        sql`select app_private.admin_list_bank_transfer_orders(${q.status}, ${q.pageSize}, ${(q.page - 1) * q.pageSize}) as r`,
      );
      const { total, items } = r.rows[0]!.r;
      return {
        items: items.map(toOrder),
        total: Number(total),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  /**
   * Đơn `pending` → `confirmed`, Pro `active` nguồn `bank_transfer` thêm 12 tháng (cộng nối nếu đang Pro còn hạn), push "Pro đã kích hoạt".
   * Gọi lại đúng cùng mã giao dịch/số tiền bởi cùng admin: trả kết quả cũ, không cộng kỳ lần hai; còn lại: 409 `CONFLICT_STALE`.
   */
  confirm(
    adminUserId: string,
    id: string,
    body: ConfirmBankTransferRequest,
  ): Promise<BankTransferConfirmed> {
    return this.run(adminUserId, async (t) => {
      const res = await t.execute<{
        r: {
          result: string;
          order?: RawOrder;
          subscription?: {
            planCode: 'free' | 'pro';
            status: 'free' | 'trialing' | 'active' | 'expired';
            currentPeriodEndMs: number | null;
          };
        };
      }>(
        sql`select app_private.admin_confirm_bank_transfer(${id}::uuid, ${body.amount}::bigint, ${body.bankTransactionRef}, ${body.expectedUpdatedAt}::timestamptz) as r`,
      );
      const r = res.rows[0]!.r;
      if (r.result === 'not_found') throw new AppException('NOT_FOUND');
      if (r.result === 'stale') throw new AppException('CONFLICT_STALE');
      if (r.result === 'amount_mismatch')
        throw new AppException('VALIDATION_FAILED', undefined, {
          amount: ['Số tiền không khớp với đơn.'],
        });
      const sub = r.subscription!;
      return {
        order: toOrder(r.order!),
        subscription: {
          planCode: sub.planCode,
          status: sub.status,
          currentPeriodEnd:
            sub.currentPeriodEndMs === null
              ? null
              : iso(sub.currentPeriodEndMs),
        },
      };
    });
  }
}
