import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AppException, paginated, toLimitOffset } from '@teachhub/core';
import {
  billingPeriods,
  classes,
  enrollments,
  invoices,
  payments,
  studentLedger,
  students,
  tenants,
  type Tx,
} from '@teachhub/db';
import { formatInZone, localDate } from '@teachhub/modules/schedule';
import { remainingOf } from '../domain/payment.js';
import type {
  StudentLedger,
  StudentLedgerQuery,
} from '../http/payments.schemas.js';
import type {
  Receivables,
  ReceivablesQuery,
  StudentReceivableHistory,
} from '../http/receivables.schemas.js';
import { toPayment } from './payments.service.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';
const BUCKETS = ['0-30', '31-60', 'over-60'] as const;
const OPEN_STATUSES = ['issued', 'partially_paid', 'pending_confirmation'];
const OPEN = sql`('issued', 'partially_paid', 'pending_confirmation')`;
const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

/**
 * Công nợ (T11, US-8.3) và sổ học viên (US-7.6), chỉ đọc. Nợ ròng = max(0, Σ còn nợ hóa đơn + số dư sổ); còn nợ = `total − paid − carried`: phần đã chuyển sang hóa đơn kỳ sau chỉ tính ở hóa đơn kỳ sau nên không đếm hai lần.
 * Mọi truy vấn lọc `tenant_id` tường minh (RLS là lớp thứ hai); học viên của tenant khác → 404.
 * shortcut: nhắc nợ (`reminders`) trả rỗng và `dunningEnabled` luôn true tới khi S6-BE-04 có bảng nhắc nợ.
 */
@Injectable()
export class ReceivablesService {
  async list(
    tx: Tx,
    tenantId: string,
    q: ReceivablesQuery,
  ): Promise<Receivables> {
    const tz = await this.timezone(tx, tenantId);
    const today = localDate(new Date(), tz);
    const filters = [
      q.classId
        ? sql`and exists (select 1 from enrollments e where e.tenant_id = ${tenantId}::uuid and e.student_id = d.student_id
            and e.class_id = ${q.classId}::uuid and e.left_on is null)`
        : sql``,
      q.q
        ? sql`and s.full_name_unaccent like '%' || lower(app_private.f_unaccent(${escapeLike(q.q)})) || '%'`
        : sql``,
    ];
    // Một dòng mỗi học viên còn nợ; tuổi nợ tính từ hạn của hóa đơn cũ nhất còn nợ (múi giờ tenant).
    const base = sql`
      with open_inv as (
        select i.student_id,
               sum(i.total_amount - i.paid_amount - i.carried_amount)::bigint as amount,
               count(*)::int as invoice_count,
               min(coalesce(i.oldest_due_date, p.due_date)) as due
          from invoices i join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
         where i.tenant_id = ${tenantId}::uuid and i.status in ${OPEN}
           and i.total_amount - i.paid_amount - i.carried_amount > 0
         group by i.student_id
      ), led as (
        select l.student_id, sum(l.debit - l.credit)::bigint as balance
          from student_ledger l where l.tenant_id = ${tenantId}::uuid
         group by l.student_id
      ), led_due as (
        select l.student_id, min(coalesce(i.oldest_due_date, p.due_date)) as due
          from student_ledger l
          join invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
          join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
         where l.tenant_id = ${tenantId}::uuid and l.debit > 0
         group by l.student_id
      ), debt as (
        -- Nợ ròng = max(0, Σ còn nợ hóa đơn + số dư sổ): sổ âm (trả thừa) giảm nợ, sổ dương (nợ ở sổ) tăng nợ; nợ ròng 0 thì không có dòng.
        select coalesce(o.student_id, g.student_id) as student_id,
               coalesce(o.amount, 0) + coalesce(g.balance, 0) as amount,
               greatest(1, coalesce(o.invoice_count, 0))::int as invoice_count,
               coalesce(least(o.due, case when g.balance is not null then d.due end), ${today}::date) as oldest_due
          from open_inv o full join led g on g.student_id = o.student_id
          left join led_due d on d.student_id = coalesce(o.student_id, g.student_id)
         where coalesce(o.amount, 0) + coalesce(g.balance, 0) > 0
      ), base as (
        select d.student_id, s.full_name, d.amount, d.invoice_count, d.oldest_due::text as oldest_due,
               greatest(0, ${today}::date - d.oldest_due)::int as overdue,
               case when ${today}::date - d.oldest_due <= 30 then '0-30'
                    when ${today}::date - d.oldest_due <= 60 then '31-60' else 'over-60' end as bucket
          from debt d join students s on s.tenant_id = ${tenantId}::uuid and s.id = d.student_id
         where true ${sql.join(filters, sql` `)}
      )`;
    const summaryRows = (
      await tx.execute<{ bucket: string; n: number; total: string }>(
        sql`${base} select bucket, count(*)::int as n, sum(amount)::text as total from base group by bucket`,
      )
    ).rows;
    const buckets = BUCKETS.map((b) => {
      const r = summaryRows.find((x) => x.bucket === b);
      return {
        agingBucket: b,
        studentCount: r?.n ?? 0,
        totalAmount: Number(r?.total ?? 0),
      };
    });

    const bucketWhere = q.agingBucket
      ? sql`where bucket = ${q.agingBucket}`
      : sql``;
    const dir = q.sortOrder === 'asc' ? sql`asc` : sql`desc`;
    const order =
      q.sortField === 'studentName'
        ? sql`lower(full_name) ${dir}`
        : q.sortField === 'overdueDays'
          ? sql`overdue ${dir}`
          : sql`amount ${dir}`;
    const { limit, offset } = toLimitOffset(q);
    const page = (
      await tx.execute<{
        student_id: string;
        full_name: string;
        amount: string;
        invoice_count: number;
        oldest_due: string;
        overdue: number;
        bucket: Receivables['items'][number]['agingBucket'];
      }>(
        sql`${base} select * from base ${bucketWhere} order by ${order}, student_id limit ${limit} offset ${offset}`,
      )
    ).rows;
    // Tổng số dòng = Σ studentCount của nhóm được lọc (summary đã đếm theo cùng classId/q).
    const total = buckets
      .filter((b) => !q.agingBucket || b.agingBucket === q.agingBucket)
      .reduce((n, b) => n + b.studentCount, 0);

    const classNames = new Map<string, string[]>();
    if (page.length) {
      const rows = await tx
        .select({ studentId: enrollments.studentId, name: classes.name })
        .from(enrollments)
        .innerJoin(
          classes,
          and(
            eq(classes.tenantId, enrollments.tenantId),
            eq(classes.id, enrollments.classId),
          ),
        )
        .where(
          and(
            eq(enrollments.tenantId, tenantId),
            inArray(
              enrollments.studentId,
              page.map((r) => r.student_id),
            ),
            isNull(enrollments.leftOn),
          ),
        )
        .orderBy(classes.name);
      for (const r of rows)
        classNames.set(r.studentId, [
          ...(classNames.get(r.studentId) ?? []),
          r.name,
        ]);
    }
    return {
      ...paginated(
        page.map((r) => ({
          studentId: r.student_id,
          studentName: r.full_name,
          classNames: classNames.get(r.student_id) ?? [],
          outstandingAmount: Number(r.amount),
          openInvoiceCount: r.invoice_count,
          oldestDueDate: r.oldest_due,
          overdueDays: r.overdue,
          agingBucket: r.bucket,
        })),
        total,
        q,
      ),
      summary: {
        totalAmount: buckets.reduce((n, b) => n + b.totalAmount, 0),
        buckets,
      },
    };
  }

  /** Lịch sử hóa đơn, thanh toán, nhắc nợ của một học viên (US-8.3 AC3). */
  async history(
    tx: Tx,
    tenantId: string,
    studentId: string,
  ): Promise<StudentReceivableHistory> {
    const stu = await this.student(tx, tenantId, studentId);
    const tz = await this.timezone(tx, tenantId);
    const invRows = await tx
      .select({
        i: invoices,
        periodMonth: billingPeriods.periodMonth,
        dueDate: billingPeriods.dueDate,
      })
      .from(invoices)
      .innerJoin(
        billingPeriods,
        and(
          eq(billingPeriods.tenantId, invoices.tenantId),
          eq(billingPeriods.id, invoices.periodId),
        ),
      )
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.studentId, studentId),
          ne(invoices.status, 'draft'),
        ),
      )
      .orderBy(desc(invoices.issuedAt), desc(invoices.id));
    const remaining = (r: (typeof invRows)[number]) =>
      r.i.status === 'void'
        ? 0
        : remainingOf(r.i.totalAmount, r.i.paidAmount, r.i.carriedAmount);
    const { balance } = await this.ledgerStats(tx, tenantId, studentId);
    // Nợ ròng = max(0, Σ còn nợ hóa đơn + số dư sổ), khớp `GET /receivables`.
    const invoiceOutstanding = invRows
      .filter((r) => OPEN_STATUSES.includes(r.i.status))
      .reduce((n, r) => n + remaining(r), 0);
    const outstanding = Math.max(0, invoiceOutstanding + balance);
    const code = new Map(invRows.map((r) => [r.i.id, r.i.code]));

    const payRows = invRows.length
      ? await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.tenantId, tenantId),
              inArray(
                payments.invoiceId,
                invRows.map((r) => r.i.id),
              ),
            ),
          )
          .orderBy(desc(payments.recordedAt), desc(payments.id))
          .limit(50)
      : [];
    const enr = await tx
      .select({
        enrollmentId: enrollments.id,
        classId: enrollments.classId,
        className: classes.name,
      })
      .from(enrollments)
      .innerJoin(
        classes,
        and(
          eq(classes.tenantId, enrollments.tenantId),
          eq(classes.id, enrollments.classId),
        ),
      )
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.studentId, studentId),
          isNull(enrollments.leftOn),
        ),
      )
      .orderBy(classes.name);
    return {
      studentId,
      studentName: stu.fullName,
      outstandingAmount: outstanding,
      invoiceOutstandingAmount: invoiceOutstanding,
      ledgerBalanceAmount: balance,
      dunningEnabled: true,
      enrollments: enr.map((e) => ({ ...e, dunningEnabled: true })),
      invoices: invRows.slice(0, 24).map((r) => ({
        id: r.i.id,
        code: r.i.code,
        periodMonth: r.periodMonth,
        status: r.i
          .status as StudentReceivableHistory['invoices'][number]['status'],
        totalAmount: r.i.totalAmount,
        paidAmount: r.i.paidAmount,
        remainingAmount: remaining(r),
        dueDate: r.dueDate,
      })),
      payments: payRows.map((p) => ({
        ...toPayment(p, tz),
        invoiceCode: code.get(p.invoiceId) ?? null,
      })),
      reminders: [],
    };
  }

  /** Sổ học viên: số dư và các bút toán mới nhất trước (US-7.6). */
  async ledger(
    tx: Tx,
    tenantId: string,
    studentId: string,
    q: StudentLedgerQuery,
  ): Promise<StudentLedger> {
    const stu = await this.student(tx, tenantId, studentId);
    const tz = await this.timezone(tx, tenantId);
    const where = and(
      eq(studentLedger.tenantId, tenantId),
      eq(studentLedger.studentId, studentId),
    );
    const { limit, offset } = toLimitOffset(q);
    const rows = await tx
      .select()
      .from(studentLedger)
      .where(where)
      .orderBy(desc(studentLedger.createdAt), desc(studentLedger.id))
      .limit(limit)
      .offset(offset);
    const { count, balance } = await this.ledgerStats(tx, tenantId, studentId);
    return {
      studentId,
      studentName: stu.fullName,
      balanceAmount: balance,
      debtAmount: Math.max(0, balance),
      creditAmount: Math.max(0, -balance),
      entries: paginated(
        rows.map((r) => ({
          id: r.id,
          kind: r.kind as StudentLedger['entries']['items'][number]['kind'],
          debitAmount: r.debit,
          creditAmount: r.credit,
          description: r.description,
          invoiceId: r.invoiceId,
          paymentId: r.paymentId,
          createdAt: formatInZone(r.createdAt, tz),
        })),
        count,
        q,
      ),
    };
  }

  /** Số bút toán và số dư sổ trong một truy vấn. */
  private async ledgerStats(tx: Tx, tenantId: string, studentId: string) {
    const [r] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        balance: sql<string>`coalesce(sum(${studentLedger.debit} - ${studentLedger.credit}), 0)::text`,
      })
      .from(studentLedger)
      .where(
        and(
          eq(studentLedger.tenantId, tenantId),
          eq(studentLedger.studentId, studentId),
        ),
      );
    return { count: r?.n ?? 0, balance: Number(r?.balance ?? 0) };
  }

  private async student(tx: Tx, tenantId: string, id: string) {
    const [s] = await tx
      .select({ fullName: students.fullName })
      .from(students)
      .where(and(eq(students.tenantId, tenantId), eq(students.id, id)));
    if (!s) throw new AppException('NOT_FOUND');
    return s;
  }

  private async timezone(tx: Tx, tenantId: string): Promise<string> {
    const [t] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return t?.tz ?? DEFAULT_TZ;
  }
}
