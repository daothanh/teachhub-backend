import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { AppException, paginated, toLimitOffset, uuidv7 } from '@teachhub/core';
import {
  billingPeriods,
  invoiceLines,
  invoices,
  students,
  tenants,
  type Tx,
} from '@teachhub/db';
import { formatInZone } from '@teachhub/modules/schedule';
import type {
  BillingPeriod,
  BillingPeriodDetail,
  BillingPeriodDetailQuery,
  BillingPeriodListQuery,
  BillingPeriodPage,
  CreateAdjustmentRequest,
  Invoice,
} from '../http/billing.schemas.js';

const MAX_ADJUSTMENTS = 20;
const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

export interface Actor {
  tenantId: string;
  userId: string;
}

type PeriodRow = typeof billingPeriods.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type LineRow = typeof invoiceLines.$inferSelect;

/**
 * Kỳ thu và hóa đơn của giáo viên (S5-BE-06, US-7.2). Mọi truy vấn lọc `tenant_id` tường minh, RLS là lớp thứ hai;
 * id của tenant khác → 404. Không log tên học viên hay lý do điều chỉnh.
 */
@Injectable()
export class BillingService {
  async listPeriods(
    tx: Tx,
    tenantId: string,
    query: BillingPeriodListQuery,
  ): Promise<BillingPeriodPage> {
    const where = and(
      eq(billingPeriods.tenantId, tenantId),
      query.month
        ? eq(billingPeriods.periodMonth, `${query.month}-01`)
        : undefined,
    );
    const [cnt] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(billingPeriods)
      .where(where);
    const rows = await tx
      .select()
      .from(billingPeriods)
      .where(where)
      .orderBy(desc(billingPeriods.periodMonth), desc(billingPeriods.id))
      .limit(toLimitOffset(query).limit)
      .offset(toLimitOffset(query).offset);
    const stats = await this.stats(
      tx,
      tenantId,
      rows.map((r) => r.id),
    );
    return paginated(
      rows.map((r) => toPeriod(r, stats.get(r.id))),
      cnt?.n ?? 0,
      query,
    );
  }

  async getPeriod(
    tx: Tx,
    tenantId: string,
    id: string,
    query: BillingPeriodDetailQuery,
  ): Promise<BillingPeriodDetail> {
    const [row] = await tx
      .select()
      .from(billingPeriods)
      .where(
        and(eq(billingPeriods.tenantId, tenantId), eq(billingPeriods.id, id)),
      );
    if (!row) throw new AppException('NOT_FOUND');
    const stats = await this.stats(tx, tenantId, [id]);

    const where = and(
      eq(invoices.tenantId, tenantId),
      eq(invoices.periodId, id),
      query.status ? eq(invoices.status, query.status) : undefined,
    );
    const [cnt] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(where);
    const { limit, offset } = toLimitOffset(query);
    const items = await tx
      .select({
        id: invoices.id,
        code: invoices.code,
        status: invoices.status,
        studentId: invoices.studentId,
        studentName: students.fullName,
        totalAmount: invoices.totalAmount,
        // Có mức riêng ở ít nhất một ghi danh còn hiệu lực trong kỳ.
        hasOverride: sql<boolean>`exists (
          select 1 from enrollments e
           where e.tenant_id = ${tenantId} and e.student_id = ${invoices.studentId}
             and e.fee_override is not null
             and e.joined_on < (${row.periodMonth}::date + interval '1 month')::date
             and (e.left_on is null or e.left_on > ${row.periodMonth}::date))`,
      })
      .from(invoices)
      .innerJoin(
        students,
        and(
          eq(students.tenantId, invoices.tenantId),
          eq(students.id, invoices.studentId),
        ),
      )
      .where(where)
      .orderBy(asc(students.fullNameUnaccent), asc(invoices.id))
      .limit(limit)
      .offset(offset);
    return {
      ...toPeriod(row, stats.get(id)),
      invoices: paginated(
        items.map((i) => ({ ...i, status: i.status as Invoice['status'] })),
        cnt?.n ?? 0,
        query,
      ),
    };
  }

  async getInvoice(tx: Tx, tenantId: string, id: string): Promise<Invoice> {
    const row = await this.loadInvoice(tx, tenantId, id, false);
    return this.toInvoice(tx, tenantId, row);
  }

  /**
   * Thêm dòng điều chỉnh vào bản nháp (US-7.2 AC3): khóa dòng hóa đơn trước khi ghi dòng (đúng thứ tự khóa của trigger
   * `invoice_lines_guard`), chỉ `draft`, tối đa 20 dòng, tính lại tổng và ghi `audit_logs` (người sửa, trước/sau).
   */
  async adjust(
    tx: Tx,
    actor: Actor,
    id: string,
    body: CreateAdjustmentRequest,
  ): Promise<Invoice> {
    const inv = await this.loadInvoice(tx, actor.tenantId, id, true);
    if (inv.status !== 'draft') throw new AppException('INVOICE_IMMUTABLE');

    const lines = await tx
      .select({
        position: invoiceLines.position,
        kind: invoiceLines.kind,
        amount: invoiceLines.amount,
      })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.tenantId, actor.tenantId),
          eq(invoiceLines.invoiceId, id),
        ),
      );
    if (
      lines.filter((l) => l.kind === 'manual_adjustment').length >=
      MAX_ADJUSTMENTS
    ) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        amount: [`Tối đa ${MAX_ADJUSTMENTS} dòng điều chỉnh cho mỗi hóa đơn.`],
      });
    }
    await tx.insert(invoiceLines).values({
      id: uuidv7(),
      tenantId: actor.tenantId,
      invoiceId: id,
      position: Math.max(0, ...lines.map((l) => l.position)) + 1,
      kind: 'manual_adjustment',
      description: body.description,
      amount: body.amount,
      charged: true,
      adjustmentReason: body.adjustmentReason,
    });
    const sum = lines.reduce((acc, l) => acc + l.amount, 0) + body.amount;
    const totalAmount = Math.max(0, sum);
    const clampedAmount = Math.max(0, -sum);
    await tx
      .update(invoices)
      .set({ totalAmount, clampedAmount })
      .where(and(eq(invoices.tenantId, actor.tenantId), eq(invoices.id, id)));
    await tx.execute(
      sql`select app_private.audit_insert(${actor.tenantId}::uuid, 'invoice_adjustment', ${id}::uuid, 'update',
        ${JSON.stringify({ totalAmount: inv.totalAmount, clampedAmount: inv.clampedAmount })}::jsonb,
        ${JSON.stringify({
          totalAmount,
          clampedAmount,
          adjustment: {
            amount: body.amount,
            description: body.description,
            reason: body.adjustmentReason,
          },
        })}::jsonb)`,
    );
    return this.getInvoice(tx, actor.tenantId, id);
  }

  private async loadInvoice(
    tx: Tx,
    tenantId: string,
    id: string,
    lock: boolean,
  ): Promise<InvoiceRow> {
    const q = tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, id)));
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new AppException('NOT_FOUND');
    return row;
  }

  private async toInvoice(
    tx: Tx,
    tenantId: string,
    inv: InvoiceRow,
  ): Promise<Invoice> {
    const [period] = await tx
      .select()
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.tenantId, tenantId),
          eq(billingPeriods.id, inv.periodId),
        ),
      );
    const [student] = await tx
      .select({ fullName: students.fullName })
      .from(students)
      .where(
        and(eq(students.tenantId, tenantId), eq(students.id, inv.studentId)),
      );
    const [tenant] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const tz = tenant?.tz ?? DEFAULT_TZ;
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.tenantId, tenantId),
          eq(invoiceLines.invoiceId, inv.id),
        ),
      )
      .orderBy(asc(invoiceLines.position));
    const at = (d: Date | null) => (d ? formatInZone(d, tz) : null);
    return {
      id: inv.id,
      periodId: inv.periodId,
      periodMonth: period!.periodMonth,
      code: inv.code,
      transferNote: inv.transferNote,
      qrPayload: inv.qrPayload,
      status: inv.status as Invoice['status'],
      studentId: inv.studentId,
      studentName: student?.fullName ?? '',
      totalAmount: inv.totalAmount,
      dueDate: period!.dueDate,
      issuedAt: at(inv.issuedAt),
      payout: inv.payout as Invoice['payout'],
      voidedAt: at(inv.voidedAt),
      voidReason: inv.voidReason,
      replacesInvoiceId: inv.replacesInvoiceId,
      replacementInvoiceId: inv.replacementInvoiceId,
      lines: lines.map(toLine),
      installmentNo: inv.installmentNo,
      installmentCount: inv.installmentCount,
      clampedAmount: inv.clampedAmount,
      createdAt: formatInZone(inv.createdAt, tz),
    };
  }

  /** Số hóa đơn và tổng tiền theo trạng thái của các kỳ cho trước. */
  private async stats(tx: Tx, tenantId: string, periodIds: string[]) {
    const out = new Map<string, Stats>();
    if (!periodIds.length) return out;
    const rows = await tx
      .select({
        periodId: invoices.periodId,
        draftCount: sql<number>`count(*) filter (where ${invoices.status} = 'draft')::int`,
        issuedCount: sql<number>`count(*) filter (where ${invoices.status} not in ('draft', 'void'))::int`,
        voidCount: sql<number>`count(*) filter (where ${invoices.status} = 'void')::int`,
        draftTotalAmount: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} = 'draft'), 0)::bigint`,
        issuedTotalAmount: sql<number>`coalesce(sum(${invoices.totalAmount}) filter (where ${invoices.status} not in ('draft', 'void')), 0)::bigint`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          sql`${invoices.periodId} in (${sql.join(
            periodIds.map((p) => sql`${p}::uuid`),
            sql`, `,
          )})`,
        ),
      )
      .groupBy(invoices.periodId);
    for (const r of rows)
      out.set(r.periodId, {
        draftCount: r.draftCount,
        issuedCount: r.issuedCount,
        voidCount: r.voidCount,
        draftTotalAmount: Number(r.draftTotalAmount),
        issuedTotalAmount: Number(r.issuedTotalAmount),
      });
    return out;
  }
}

type Stats = Pick<
  BillingPeriod,
  | 'draftCount'
  | 'issuedCount'
  | 'voidCount'
  | 'draftTotalAmount'
  | 'issuedTotalAmount'
>;

const EMPTY: Stats = {
  draftCount: 0,
  issuedCount: 0,
  voidCount: 0,
  draftTotalAmount: 0,
  issuedTotalAmount: 0,
};

const toPeriod = (r: PeriodRow, s: Stats = EMPTY): BillingPeriod => ({
  id: r.id,
  periodMonth: r.periodMonth,
  closeDate: r.closeDate,
  dueDate: r.dueDate,
  status: r.status as BillingPeriod['status'],
  ...s,
});

const toLine = (l: LineRow): Invoice['lines'][number] => ({
  id: l.id,
  kind: l.kind as Invoice['lines'][number]['kind'],
  description: l.description,
  amount: l.amount,
  charged: l.charged,
  notChargedReason:
    l.notChargedReason as Invoice['lines'][number]['notChargedReason'],
  sessionId: l.sessionId,
  sessionDate: l.sessionDate,
  className: l.className,
  adjustmentReason: l.adjustmentReason,
});
