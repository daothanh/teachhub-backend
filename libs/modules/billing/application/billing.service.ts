import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AppException,
  MAX_VND,
  paginated,
  toLimitOffset,
  uuidv7,
} from '@teachhub/core';
import {
  billingPeriods,
  invoiceLines,
  invoices,
  outboxEvents,
  payoutAccounts,
  students,
  tenants,
  type Tx,
  writeAudit,
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
  IssueInvoicesRequest,
  IssueInvoicesResult,
  VoidInvoiceRequest,
  VoidInvoiceResult,
} from '../http/billing.schemas.js';
import {
  generateInvoiceCode,
  INVOICE_ISSUED,
  type InvoiceIssuedPayload,
  transferNoteOf,
} from '../domain/invoice-issue.js';
import { buildVietQrPayload } from '../domain/vietqr.js';

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
    // Tổng = max(0, Σ tổng từng ghi danh đã cắt bởi calculator + Σ dòng điều chỉnh). `total - clamped` chính là tổng chưa
    // cắt đó (total khi ≥ 0, -clamped khi âm), nên không tính lại từ tổng thô các dòng.
    const sum = inv.totalAmount - inv.clampedAmount + body.amount;
    if (Math.abs(sum) > MAX_VND) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        amount: ['Tổng hóa đơn vượt giới hạn cho phép.'],
      });
    }
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

  /**
   * Phát hành hóa đơn nháp của kỳ trong MỘT giao dịch (US-7.2 AC4, US-7.3). Khóa kỳ rồi khóa hóa đơn `order by id for update`
   * (cùng thứ tự với trigger `invoice_lines_guard`, comment 0024) nên hai request song song cùng kỳ nối đuôi nhau: request sau
   * đọc lại trạng thái đã commit, không phát hành trùng. Hóa đơn 0 đ giữ nguyên bản nháp, không phát sinh outbox (US-1.3 AC3).
   * shortcut: `payout.bankName` luôn null vì chưa có bảng BIN NAPAS; thêm bảng tra khi có nguồn dữ liệu.
   * Khóa advisory theo tenant (lấy đầu giao dịch, trước khóa kỳ) tuần tự hóa cấp mã nên không trùng mã giữa các kỳ song song.
   */
  async issue(
    tx: Tx,
    actor: Actor,
    periodId: string,
    body: IssueInvoicesRequest,
  ): Promise<IssueInvoicesResult> {
    const { tenantId } = actor;
    // Tuần tự hóa phát hành trong tenant: cấp mã không trùng giữa các kỳ chạy song song. Luôn lấy trước khóa kỳ.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}))`);
    const [period] = await tx
      .select()
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.tenantId, tenantId),
          eq(billingPeriods.id, periodId),
        ),
      )
      .for('update');
    if (!period) throw new AppException('NOT_FOUND');

    const [account] = await tx
      .select()
      .from(payoutAccounts)
      .where(
        and(
          eq(payoutAccounts.tenantId, tenantId),
          eq(payoutAccounts.isPrimary, true),
        ),
      );
    if (!account) throw new AppException('PAYOUT_ACCOUNT_MISSING');

    const wanted = body.invoiceIds ? [...new Set(body.invoiceIds)] : null;
    const rows = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.periodId, periodId),
          wanted ? inArray(invoices.id, wanted) : eq(invoices.status, 'draft'),
        ),
      )
      .orderBy(asc(invoices.id))
      .for('update');
    if (wanted && rows.length !== wanted.length)
      throw new AppException('NOT_FOUND');

    const names = new Map(
      (
        await tx
          .select({ id: students.id, name: students.fullName })
          .from(students)
          .where(
            and(
              eq(students.tenantId, tenantId),
              inArray(students.id, [...new Set(rows.map((r) => r.studentId))]),
            ),
          )
      ).map((r) => [r.id, r.name]),
    );
    const nameOf = (id: string) => names.get(id) ?? '';

    const skipped: IssueInvoicesResult['skipped'] = [];
    const todo: InvoiceRow[] = [];
    for (const r of rows) {
      if (r.status !== 'draft')
        skipped.push({
          invoiceId: r.id,
          studentName: nameOf(r.studentId),
          reason: 'NOT_DRAFT',
        });
      else if (r.totalAmount <= 0)
        skipped.push({
          invoiceId: r.id,
          studentName: nameOf(r.studentId),
          reason: 'ZERO_AMOUNT',
        });
      else todo.push(r);
    }

    const codes = await this.freshCodes(tx, tenantId, todo.length);
    const payout = {
      bankBin: account.bankBin,
      bankName: null,
      accountNo: account.accountNo,
      accountName: account.accountName,
    };
    const issued: IssueInvoicesResult['invoices'] = [];
    const events: (typeof outboxEvents.$inferInsert)[] = [];
    const audits: { id: string; before: object; after: object }[] = [];
    for (const [i, inv] of todo.entries()) {
      const code = codes[i]!;
      const transferNote = transferNoteOf(code);
      const qrPayload = buildVietQrPayload({
        bankBin: account.bankBin,
        accountNo: account.accountNo,
        amount: inv.totalAmount,
        transferNote,
      });
      await tx
        .update(invoices)
        .set({
          status: 'issued',
          code,
          transferNote,
          qrPayload,
          payout,
          issuedAt: new Date(),
        })
        .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, inv.id)));
      events.push({
        id: uuidv7(),
        tenantId,
        type: INVOICE_ISSUED,
        payload: {
          invoiceId: inv.id,
          studentId: inv.studentId,
          periodMonth: period.periodMonth,
          totalAmount: inv.totalAmount,
          dueDate: period.dueDate,
        } satisfies InvoiceIssuedPayload,
      });
      audits.push({
        id: inv.id,
        before: { status: 'draft', totalAmount: inv.totalAmount },
        // Không đưa số tài khoản vào audit_logs.
        after: { status: 'issued', code, totalAmount: inv.totalAmount },
      });
      issued.push({
        id: inv.id,
        code,
        studentId: inv.studentId,
        studentName: nameOf(inv.studentId),
        totalAmount: inv.totalAmount,
        dueDate: period.dueDate,
        transferNote,
        qrPayload,
      });
    }

    if (events.length) {
      await tx.insert(outboxEvents).values(events);
      await tx.execute(
        sql`select app_private.audit_insert(${tenantId}::uuid, 'invoice', v.id::uuid, 'update', v.b::jsonb, v.a::jsonb)
          from (values ${sql.join(
            audits.map(
              (a) =>
                sql`(${a.id}, ${JSON.stringify(a.before)}, ${JSON.stringify(a.after)})`,
            ),
            sql`, `,
          )}) as v(id, b, a)`,
      );
    }

    // Kỳ đóng khi không còn bản nháp nào có tiền để phát hành (bản nháp 0 đ không chặn).
    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.periodId, periodId),
          eq(invoices.status, 'draft'),
          sql`${invoices.totalAmount} > 0`,
        ),
      );
    if (!left?.n && period.status !== 'closed')
      await tx
        .update(billingPeriods)
        .set({ status: 'closed' })
        .where(
          and(
            eq(billingPeriods.tenantId, tenantId),
            eq(billingPeriods.id, periodId),
          ),
        );

    return {
      issuedCount: issued.length,
      skipped,
      totalAmount: issued.reduce((s, i) => s + i.totalAmount, 0),
      invoices: issued,
    };
  }

  /**
   * Hủy hóa đơn đã phát hành (US-7.3 AC4), có lý do và ghi audit; không đụng số tiền (trigger cũng chặn). Đã hủy gọi lại → trả
   * bản hiện tại. `draft` và các trạng thái đã có thanh toán → 409 CONFLICT_STALE.
   * shortcut: `createReplacementDraft = true` chờ TL xác nhận nên trả 422 thay vì tạo bản nháp thay thế; làm khi TL chốt.
   */
  async voidInvoice(
    tx: Tx,
    actor: Actor,
    id: string,
    body: VoidInvoiceRequest,
  ): Promise<VoidInvoiceResult> {
    if (body.createReplacementDraft)
      throw new AppException('VALIDATION_FAILED', undefined, {
        createReplacementDraft: ['Chưa hỗ trợ tạo bản nháp thay thế.'],
      });
    const inv = await this.loadInvoice(tx, actor.tenantId, id, true);
    if (inv.status === 'void')
      return {
        invoice: await this.toInvoice(tx, actor.tenantId, inv),
        replacementInvoiceId: null,
      };
    if (inv.status !== 'issued') throw new AppException('CONFLICT_STALE');
    await tx
      .update(invoices)
      .set({ status: 'void', voidedAt: new Date(), voidReason: body.reason })
      .where(and(eq(invoices.tenantId, actor.tenantId), eq(invoices.id, id)));
    await writeAudit(tx, {
      tenantId: actor.tenantId,
      entity: 'invoice',
      entityId: id,
      action: 'update',
      before: { status: 'issued', code: inv.code },
      after: { status: 'void', code: inv.code, reason: body.reason },
    });
    return {
      invoice: await this.getInvoice(tx, actor.tenantId, id),
      replacementInvoiceId: null,
    };
  }

  /** `n` mã chưa dùng trong tenant (đọc trước, ràng buộc unique là lớp cuối). */
  private async freshCodes(tx: Tx, tenantId: string, n: number) {
    const codes = new Set<string>();
    while (codes.size < n) {
      while (codes.size < n) codes.add(generateInvoiceCode());
      const taken = await tx
        .select({ code: invoices.code })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            inArray(invoices.code, [...codes]),
          ),
        );
      for (const r of taken) codes.delete(r.code!);
    }
    return [...codes];
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
      // Sprint 5 chưa có thanh toán nên đúng là 0; S6-BE-02 thay bằng Σ payments chưa hủy.
      paidAmount: 0,
      remainingAmount:
        inv.status === 'void' || inv.status === 'draft' ? 0 : inv.totalAmount,
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
