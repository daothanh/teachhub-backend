import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { paginated, toLimitOffset } from '@teachhub/core';
import { tenants, type Tx } from '@teachhub/db';
import {
  ReceivablesService,
  receivablesQuerySchema,
} from '@teachhub/modules/billing';
import { localDate } from '@teachhub/modules/schedule';
import {
  allocate,
  type ClassKey,
  type InvoiceLine,
  invoiceWeights,
  OTHER,
} from '../domain/revenue-allocation.js';
import type {
  MonthOverview,
  ReportMonthQuery,
  Revenue12m,
  RevenueByClass,
  RevenueEntries,
  RevenueEntriesQuery,
} from '../http/reports.schemas.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

/** Cộng `n` tháng vào `YYYY-MM`. */
export const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

/**
 * Báo cáo doanh thu T12 (US-8.1, US-8.2), chỉ đọc. "Đã thu" lấy từ `revenue_ledger` (theo ngày thu, gồm dòng đảo) nên
 * khớp từng đồng với danh sách thanh toán; "Phải thu" từ hóa đơn đã phát hành của kỳ; công nợ dùng lại `ReceivablesService`
 * để bằng `GET /receivables`. Mọi truy vấn lọc `tenant_id` tường minh (RLS là lớp thứ hai).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly receivables: ReceivablesService) {}

  async monthOverview(
    tx: Tx,
    tenantId: string,
    q: ReportMonthQuery,
  ): Promise<MonthOverview> {
    const month = await this.month(tx, tenantId, q);
    const start = `${month}-01`;
    const [row] = (
      await tx.execute<{
        collected: string;
        entries: number;
        billed: string;
        invoices: number;
        students: number;
      }>(sql`
        select
          (select coalesce(sum(amount), 0)::text from revenue_ledger
            where tenant_id = ${tenantId}::uuid and ${inMonth(sql`entry_date`, start)}) as collected,
          (select count(*)::int from revenue_ledger
            where tenant_id = ${tenantId}::uuid and ${inMonth(sql`entry_date`, start)}) as entries,
          (select coalesce(sum(i.total_amount), 0)::text from invoices i
             join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
            where i.tenant_id = ${tenantId}::uuid and p.period_month = ${start}::date
              and i.status not in ('draft', 'void')) as billed,
          (select count(*)::int from invoices i
             join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
            where i.tenant_id = ${tenantId}::uuid and p.period_month = ${start}::date
              and i.status not in ('draft', 'void')) as invoices,
          (select count(*)::int from students
            where tenant_id = ${tenantId}::uuid and status = 'active') as students`)
    ).rows;
    // Chỉ cần `summary.totalAmount`: một dòng là đủ, tổng không phụ thuộc trang.
    const debt = await this.receivables.list(
      tx,
      tenantId,
      receivablesQuerySchema.parse({ pageSize: 1 }),
    );
    return {
      month,
      billedAmount: Number(row!.billed),
      collectedAmount: Number(row!.collected),
      outstandingAmount: debt.summary.totalAmount,
      activeStudentCount: row!.students,
      hasData: row!.invoices > 0 || row!.entries > 0,
    };
  }

  async payments(
    tx: Tx,
    tenantId: string,
    q: RevenueEntriesQuery,
  ): Promise<RevenueEntries> {
    const month = await this.month(tx, tenantId, q);
    const start = `${month}-01`;
    const { limit, offset } = toLimitOffset(q);
    const [agg] = (
      await tx.execute<{ n: number; total: string }>(sql`
        select count(*)::int as n, coalesce(sum(amount), 0)::text as total from revenue_ledger
         where tenant_id = ${tenantId}::uuid and ${inMonth(sql`entry_date`, start)}`)
    ).rows;
    const rows = (
      await tx.execute<{
        id: string;
        kind: 'payment' | 'reversal';
        payment_id: string;
        invoice_id: string;
        code: string | null;
        student_id: string;
        full_name: string;
        method: 'bank_transfer' | 'cash';
        entry_date: string;
        amount: string;
      }>(sql`
        select r.id, r.kind, r.payment_id, p.invoice_id, i.code, i.student_id, s.full_name, p.method,
               r.entry_date::text as entry_date, r.amount::text as amount
          from revenue_ledger r
          join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
          join invoices i on i.tenant_id = p.tenant_id and i.id = p.invoice_id
          join students s on s.tenant_id = i.tenant_id and s.id = i.student_id
         where r.tenant_id = ${tenantId}::uuid and ${inMonth(sql`r.entry_date`, start)}
         order by r.entry_date desc, r.created_at desc, r.id desc
         limit ${limit} offset ${offset}`)
    ).rows;
    return {
      ...paginated(
        rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          paymentId: r.payment_id,
          invoiceId: r.invoice_id,
          invoiceCode: r.code,
          studentId: r.student_id,
          studentName: r.full_name,
          method: r.method,
          entryDate: r.entry_date,
          amount: Number(r.amount),
        })),
        agg!.n,
        q,
      ),
      totalAmount: Number(agg!.total),
    };
  }

  async revenueByClass(
    tx: Tx,
    tenantId: string,
    q: ReportMonthQuery,
  ): Promise<RevenueByClass> {
    const month = await this.month(tx, tenantId, q);
    const start = `${month}-01`;
    const entries = (
      await tx.execute<{ invoice_id: string; amount: string }>(sql`
        select p.invoice_id, r.amount::text as amount
          from revenue_ledger r
          join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
         where r.tenant_id = ${tenantId}::uuid and ${inMonth(sql`r.entry_date`, start)}`)
    ).rows;

    const classes = (
      await tx.execute<{ id: string; name: string; archived: boolean }>(sql`
        select id, name, (status = 'archived') as archived from classes where tenant_id = ${tenantId}::uuid`)
    ).rows;
    // Dòng hóa đơn chỉ lưu tên lớp (snapshot): chỉ nhận tên khớp đúng một lớp; trùng tên hay lớp đã xóa → "Khác".
    const byName = new Map<string, string | null>();
    for (const c of classes)
      byName.set(c.name, byName.has(c.name) ? null : c.id);

    const invoiceIds = [...new Set(entries.map((e) => e.invoice_id))];
    const linesByInvoice = new Map<string, InvoiceLine[]>();
    if (invoiceIds.length) {
      const lines = (
        await tx.execute<{
          invoice_id: string;
          kind: string;
          amount: string;
          charged: boolean;
          class_name: string | null;
          session_class_id: string | null;
        }>(sql`
          select l.invoice_id, l.kind, l.amount::text as amount, l.charged, l.class_name, s.class_id as session_class_id
            from invoice_lines l
            left join sessions s on s.tenant_id = l.tenant_id and s.id = l.session_id
           where l.tenant_id = ${tenantId}::uuid
             and l.invoice_id in (${sql.join(
               invoiceIds.map((id) => sql`${id}::uuid`),
               sql`, `,
             )})`)
      ).rows;
      for (const l of lines) {
        const list = linesByInvoice.get(l.invoice_id) ?? [];
        list.push({
          kind: l.kind,
          amount: Number(l.amount),
          charged: l.charged,
          classId:
            l.session_class_id ??
            (l.class_name ? (byName.get(l.class_name) ?? null) : null),
        });
        linesByInvoice.set(l.invoice_id, list);
      }
    }

    // Chia từng bút toán (không cộng trước theo hóa đơn) để dòng đảo đảo đúng từng đồng phần của khoản thu gốc.
    const collected = new Map<ClassKey, number>();
    const weightsOf = new Map<string, Map<ClassKey, number>>();
    for (const e of entries) {
      const w =
        weightsOf.get(e.invoice_id) ??
        invoiceWeights(linesByInvoice.get(e.invoice_id) ?? []);
      weightsOf.set(e.invoice_id, w);
      for (const [k, v] of allocate(Number(e.amount), w))
        collected.set(k, (collected.get(k) ?? 0) + v);
    }

    const attendance = new Map<string, number | null>();
    const taught = new Set<string>();
    for (const r of (
      await tx.execute<{ class_id: string; pct: string | null }>(sql`
        select s.class_id,
               round(100.0 * count(*) filter (where a.status in ('present', 'late')) / nullif(count(a.id), 0), 1)::text as pct
          from sessions s
          left join attendance a on a.tenant_id = s.tenant_id and a.session_id = s.id
         where s.tenant_id = ${tenantId}::uuid and s.status = 'taught' and ${inMonth(sql`s.session_date`, start)}
         group by s.class_id`)
    ).rows) {
      taught.add(r.class_id);
      attendance.set(r.class_id, r.pct === null ? null : Number(r.pct));
    }

    // Lớp có thu trong tháng hoặc có buổi đã dạy; lớp lưu trữ chỉ xuất hiện khi có số liệu của tháng (US-8.2 AC2).
    const items = classes
      .filter((c) => (collected.get(c.id) ?? 0) !== 0 || taught.has(c.id))
      .map((c) => ({
        classId: c.id as string | null,
        className: c.name as string | null,
        archived: c.archived,
        collectedAmount: collected.get(c.id) ?? 0,
        attendancePercent: attendance.get(c.id) ?? null,
      }))
      .sort(
        (a, b) =>
          b.collectedAmount - a.collectedAmount ||
          a.className!.localeCompare(b.className!, 'vi'),
      );
    const other = collected.get(OTHER) ?? 0;
    if (other !== 0)
      items.push({
        classId: null,
        className: null,
        archived: false,
        collectedAmount: other,
        attendancePercent: null,
      });
    return {
      month,
      collectedAmount: [...collected.values()].reduce((n, v) => n + v, 0),
      items,
    };
  }

  async revenue12m(
    tx: Tx,
    tenantId: string,
    q: ReportMonthQuery,
  ): Promise<Revenue12m> {
    const month = await this.month(tx, tenantId, q);
    const first = `${addMonths(month, -11)}-01`;
    const rows = (
      await tx.execute<{ m: string; total: string }>(sql`
        select to_char(entry_date, 'YYYY-MM') as m, sum(amount)::text as total from revenue_ledger
         where tenant_id = ${tenantId}::uuid and entry_date >= ${first}::date
           and entry_date < (${`${month}-01`}::date + interval '1 month')
         group by 1`)
    ).rows;
    const by = new Map(rows.map((r) => [r.m, Number(r.total)]));
    return {
      months: Array.from({ length: 12 }, (_, i) => {
        const m = addMonths(month, i - 11);
        return { month: m, collectedAmount: by.get(m) ?? 0 };
      }),
    };
  }

  /** Tháng chọn, mặc định tháng hiện tại theo múi giờ tenant. */
  private async month(
    tx: Tx,
    tenantId: string,
    q: ReportMonthQuery,
  ): Promise<string> {
    if (q.month) return q.month;
    const [t] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(sql`${tenants.id} = ${tenantId}::uuid`);
    return localDate(new Date(), t?.tz ?? DEFAULT_TZ).slice(0, 7);
  }
}

const inMonth = (col: ReturnType<typeof sql>, start: string) =>
  sql`${col} >= ${start}::date and ${col} < (${start}::date + interval '1 month')`;
