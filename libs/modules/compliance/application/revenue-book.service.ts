import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AppException, paginated, toLimitOffset } from '@teachhub/core';
import { tenants, type Tx } from '@teachhub/db';
import { formatInZone, localDate } from '@teachhub/modules/schedule';
import { TAX_ARTICLE_SLUG } from '../domain/checklist.js';
import {
  progressPercent,
  TAX_THRESHOLDS,
  thresholdStatus,
} from '../domain/tax-threshold.js';
import type {
  RevenueBook,
  RevenueBookQuery,
} from '../http/compliance.schemas.js';
import { publishedSlugs } from './checklist.service.js';
import { TaxThresholdService } from './tax-threshold.service.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

/** Sổ doanh thu và ngưỡng thuế T13 (US-9.5). Mọi gói xem được; đọc thẳng `revenue_ledger` nên khớp từng đồng với báo cáo T12. */
@Injectable()
export class RevenueBookService {
  constructor(private readonly thresholds: TaxThresholdService) {}

  async get(
    tx: Tx,
    tenantId: string,
    q: RevenueBookQuery,
  ): Promise<RevenueBook> {
    const [t] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const tz = t?.tz ?? DEFAULT_TZ;
    const year = q.year ?? Number(localDate(new Date(), tz).slice(0, 4));

    // Kiểm ngay khi đọc để cảnh báo không phải đợi job hằng ngày.
    await this.thresholds.evaluate(tx, tenantId, year);

    const { limit, offset } = toLimitOffset(q);
    const [agg] = (
      await tx.execute<{ n: number; total: string }>(sql`
        select count(*)::int as n, coalesce(sum(amount), 0)::text as total from revenue_ledger
         where tenant_id = ${tenantId}::uuid and fiscal_year = ${year}`)
    ).rows;
    const months = (
      await tx.execute<{ m: number; total: string }>(sql`
        select extract(month from entry_date)::int as m, sum(amount)::text as total from revenue_ledger
         where tenant_id = ${tenantId}::uuid and fiscal_year = ${year} group by 1`)
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
         where r.tenant_id = ${tenantId}::uuid and r.fiscal_year = ${year}
         order by r.entry_date desc, r.created_at desc, r.id desc
         limit ${limit} offset ${offset}`)
    ).rows;
    const alertRows = (
      await tx.execute<{
        id: string;
        milestone: '400m' | '800m';
        payment_id: string | null;
        cumulative_amount: string;
        triggered_at: Date;
        dismissed_at: Date | null;
      }>(sql`
        select id, milestone, payment_id, cumulative_amount::text, triggered_at, dismissed_at from tax_threshold_alerts
         where tenant_id = ${tenantId}::uuid and fiscal_year = ${year}
         order by triggered_at desc, id desc`)
    ).rows;
    const slugs = alertRows.length
      ? await publishedSlugs(tx, Object.values(TAX_ARTICLE_SLUG))
      : new Set<string>();

    const cumulative = Number(agg!.total);
    const byMonth = new Map(months.map((m) => [m.m, Number(m.total)]));
    return {
      year,
      cumulativeAmount: cumulative,
      monthly: Array.from({ length: 12 }, (_, i) => ({
        month: `${year}-${String(i + 1).padStart(2, '0')}`,
        amount: byMonth.get(i + 1) ?? 0,
      })),
      thresholds: TAX_THRESHOLDS.map((d) => ({
        thresholdAmount: d.thresholdAmount,
        warnAmount: d.warnAmount,
        progressPercent: progressPercent(cumulative, d.thresholdAmount),
        status: thresholdStatus(cumulative, d),
      })),
      alerts: alertRows.map((a) => {
        const d = TAX_THRESHOLDS.find((x) => x.milestone === a.milestone)!;
        const slug = TAX_ARTICLE_SLUG[a.milestone];
        return {
          id: a.id,
          milestone: a.milestone,
          warnAmount: d.warnAmount,
          thresholdAmount: d.thresholdAmount,
          cumulativeAmount: Number(a.cumulative_amount),
          paymentId: a.payment_id,
          triggeredAt: formatInZone(new Date(a.triggered_at), tz),
          dismissedAt: a.dismissed_at
            ? formatInZone(new Date(a.dismissed_at), tz)
            : null,
          legalArticleSlug: slugs.has(slug) ? slug : null,
        };
      }),
      entries: {
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
        totalAmount: cumulative,
      },
    };
  }

  /** Đóng cảnh báo: gọi lại vẫn thành công; của tenant khác hoặc không có → NOT_FOUND. */
  async dismiss(tx: Tx, tenantId: string, id: string): Promise<void> {
    const { rows } = await tx.execute(sql`
      update tax_threshold_alerts set dismissed_at = coalesce(dismissed_at, now())
       where tenant_id = ${tenantId}::uuid and id = ${id}::uuid returning id`);
    if (!rows.length) throw new AppException('NOT_FOUND');
  }
}
