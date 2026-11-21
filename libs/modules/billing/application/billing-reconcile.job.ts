import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import type { Env } from '@teachhub/core';
import { TxService, type Tx } from '@teachhub/db';
import { JobRuns } from '@teachhub/infra';
import {
  formatReconcileAlert,
  type ReconcileKind,
  type ReconcileMismatch,
  SAMPLE_IDS,
} from '../domain/reconcile-message.js';

export const JOB_BILLING_RECONCILE = 'billing.reconcile';

interface Row extends Record<string, unknown> {
  tenant_id: string;
  n: string;
  diff: string;
  ids: string[] | null;
}

/**
 * Job 03:00 đối soát tiền thu theo từng tenant, chỉ đọc (S6-BE-06). Chạy bằng role worker (BYPASSRLS) nên mọi truy vấn
 * gộp theo `tenant_id`. Kiểm: (1) Σ thanh toán chưa hủy = Σ sổ doanh thu; (2) từng thanh toán khớp dòng sổ doanh thu
 * (chưa hủy: 1 dòng thu; đã hủy: thu + đảo, tổng 0); (3) `paid_amount` hóa đơn = Σ thanh toán chưa hủy; (4) phần trả thừa
 * (paid − total) = Σ(credit − debit) `overpayment`/`payment_void` của hóa đơn trong sổ học viên.
 * Lệch: log lỗi có cấu trúc + webhook (nếu có `ALERT_WEBHOOK_URL`); không sửa dữ liệu, không làm hỏng job.
 * Trả số tenant lệch. shortcut: chưa kiểm B − P = R + L theo học viên, thêm khi có cách tính dùng chung.
 */
@Injectable()
export class BillingReconcileJob {
  private readonly log = new Logger(BillingReconcileJob.name);

  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  run(): Promise<number> {
    return this.runs.track(JOB_BILLING_RECONCILE, async () => {
      const byTenant = await this.tx.run({ userId: null }, (t) =>
        this.findMismatches(t),
      );
      for (const [tenantId, list] of byTenant) {
        for (const m of list) {
          this.log.error({
            event: 'billing_reconcile_mismatch',
            tenantId,
            ...m,
          });
        }
        await this.alert(formatReconcileAlert(tenantId, list));
      }
      return byTenant.size;
    });
  }

  private async findMismatches(t: Tx) {
    const out = new Map<string, ReconcileMismatch[]>();
    const add = (kind: ReconcileKind, rows: Row[]) => {
      for (const r of rows) {
        const list = out.get(r.tenant_id) ?? [];
        list.push({
          kind,
          count: Number(r.n),
          diffAmount: Number(r.diff),
          sampleIds: r.ids ?? [],
        });
        out.set(r.tenant_id, list);
      }
    };
    const q = async (query: ReturnType<typeof sql>) =>
      (await t.execute<Row>(query)).rows;
    const sample = sql.raw(String(SAMPLE_IDS));

    add(
      'revenue_total',
      await q(sql`
        select tenant_id, 1 as n, abs(sum(p) - sum(r)) as diff, null::uuid[] as ids from (
          select tenant_id, amount as p, 0::bigint as r from payments where voided_at is null
          union all select tenant_id, 0, amount from revenue_ledger) x
        group by tenant_id having sum(p) <> sum(r)`),
    );
    add(
      'payment_ledger',
      await q(sql`
        select p.tenant_id, count(*) as n, sum(abs(coalesce(r.s, 0) - case when p.voided_at is null then p.amount else 0 end)) as diff,
          (array_agg(p.id))[1:${sample}] as ids
        from payments p
        left join (select payment_id, count(*) filter (where kind = 'payment') as pc,
                     count(*) filter (where kind = 'reversal') as rc, sum(amount) as s
                   from revenue_ledger group by payment_id) r on r.payment_id = p.id
        where not (coalesce(r.pc, 0) = 1
          and coalesce(r.rc, 0) = (case when p.voided_at is null then 0 else 1 end)
          and coalesce(r.s, 0) = case when p.voided_at is null then p.amount else 0 end)
        group by p.tenant_id`),
    );
    add(
      'invoice_paid',
      await q(sql`
        select i.tenant_id, count(*) as n, sum(abs(i.paid_amount - coalesce(s.s, 0))) as diff,
          (array_agg(i.id))[1:${sample}] as ids
        from invoices i
        left join (select invoice_id, sum(amount) as s from payments where voided_at is null group by invoice_id) s
          on s.invoice_id = i.id
        where i.paid_amount <> coalesce(s.s, 0)
        group by i.tenant_id`),
    );
    add(
      'invoice_overpaid',
      await q(sql`
        select i.tenant_id, count(*) as n,
          sum(abs(coalesce(l.b, 0) - greatest(0, i.paid_amount - i.total_amount))) as diff,
          (array_agg(i.id))[1:${sample}] as ids
        from invoices i
        left join (select invoice_id, sum(credit - debit) as b from student_ledger
                   where kind in ('overpayment', 'payment_void') group by invoice_id) l on l.invoice_id = i.id
        where coalesce(l.b, 0) <> greatest(0, i.paid_amount - i.total_amount)
        group by i.tenant_id`),
    );
    return out;
  }

  /** Lỗi gửi chỉ log (không kèm message: URL webhook là bí mật). */
  private async alert(text: string): Promise<void> {
    const url = this.config.get('ALERT_WEBHOOK_URL', { infer: true });
    if (!url) return;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) this.log.error(`gửi cảnh báo đối soát: HTTP ${res.status}`);
    } catch (e) {
      this.log.error(`gửi cảnh báo đối soát: ${(e as Error).name}`);
    }
  }
}
