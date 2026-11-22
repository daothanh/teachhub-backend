import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import { recordOutboxEvent, type Tx } from '@teachhub/db';
import {
  TAX_THRESHOLD_ALERT,
  TAX_THRESHOLDS,
  type TaxThresholdAlertPayload,
} from '../domain/tax-threshold.js';

/**
 * Cảnh báo 80% ngưỡng thuế (US-9.5 AC3, Spec §4.4). Không móc vào luồng ghi thanh toán (không làm chậm/khóa nó): tính từ
 * `revenue_ledger` khi chủ tenant mở sổ doanh thu và bằng job `compliance.tax-threshold` hằng ngày.
 * Idempotent: unique (tenant, năm, mốc) + `ON CONFLICT DO NOTHING`; chỉ lần chèn thành công mới ghi outbox, nên
 * hai tiến trình chạy song song không báo trùng. Cảnh báo không bao giờ xóa/sinh lại: hủy thanh toán làm lũy kế giảm rồi thu lại
 * không tạo cảnh báo mới. `payment_id` = thanh toán đưa lũy kế (theo thứ tự ghi sổ `created_at, id`) chạm mốc lần đầu.
 * shortcut: dòng sổ ghi sau lần chạy job cuối của ngày và trước khi mở sổ chỉ báo ở lần kế; chấp nhận trễ ≤ 1 ngày cho push.
 */
@Injectable()
export class TaxThresholdService {
  /** Trả số cảnh báo mới sinh. */
  async evaluate(tx: Tx, tenantId: string, year: number): Promise<number> {
    const [agg] = (
      await tx.execute<{ total: string }>(sql`
        select coalesce(sum(amount), 0)::text as total from revenue_ledger
         where tenant_id = ${tenantId}::uuid and fiscal_year = ${year}`)
    ).rows;
    const cumulative = Number(agg!.total);
    const reached = TAX_THRESHOLDS.filter((t) => cumulative >= t.warnAmount);
    if (!reached.length) return 0;
    // Đã có cảnh báo thì khỏi quét cửa sổ lũy kế mỗi lần mở sổ.
    const have = new Set(
      (
        await tx.execute<{ milestone: string }>(sql`
          select milestone from tax_threshold_alerts
           where tenant_id = ${tenantId}::uuid and fiscal_year = ${year}`)
      ).rows.map((r) => r.milestone),
    );

    let created = 0;
    for (const t of reached.filter((r) => !have.has(r.milestone))) {
      const [cross] = (
        await tx.execute<{
          payment_id: string;
          created_at: Date;
          cum: string;
        }>(sql`
          select payment_id, created_at, cum::text as cum from (
            select payment_id, created_at, id, sum(amount) over (order by created_at, id) as cum
              from revenue_ledger
             where tenant_id = ${tenantId}::uuid and fiscal_year = ${year}) r
           where cum >= ${t.warnAmount}
           order by created_at, id limit 1`)
      ).rows;
      if (!cross) continue;
      const id = uuidv7();
      const [row] = (
        await tx.execute<{ id: string }>(sql`
          insert into tax_threshold_alerts (id, tenant_id, fiscal_year, milestone, payment_id, cumulative_amount, triggered_at)
          values (${id}::uuid, ${tenantId}::uuid, ${year}, ${t.milestone}, ${cross.payment_id}::uuid, ${cross.cum}::bigint, ${cross.created_at})
          on conflict (tenant_id, fiscal_year, milestone) do nothing
          returning id`)
      ).rows;
      if (!row) continue;
      const payload: TaxThresholdAlertPayload = {
        alertId: id,
        fiscalYear: year,
        milestone: t.milestone,
      };
      await recordOutboxEvent(tx, {
        tenantId,
        type: TAX_THRESHOLD_ALERT,
        payload: { ...payload },
      });
      created += 1;
    }
    return created;
  }
}
