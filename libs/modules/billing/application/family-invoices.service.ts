import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '@teachhub/core';
import { type Tx, TxService } from '@teachhub/db';
import { ConsentsService } from '@teachhub/modules/identity';
import { formatInZone } from '@teachhub/modules/schedule';
import {
  decodeInvoiceCursor,
  InvalidCursorError,
  encodeInvoiceCursor,
} from '../domain/family-invoice-cursor.js';
import type {
  FamilyInvoice,
  FamilyInvoiceList,
  FamilyInvoicesQuery,
} from '../http/billing.schemas.js';

const uuidList = (ids: string[]) =>
  sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  );

// Allowlist tường minh: trường thêm vào snapshot sau này không tự lộ cho phụ huynh.
const pickPayout = (p: NonNullable<FamilyInvoice['payout']>) => ({
  bankBin: p.bankBin,
  bankName: p.bankName,
  accountNo: p.accountNo,
  accountName: p.accountName,
});

type Child = { name: string; teacher: string };
type Row = {
  id: string;
  code: string;
  status: FamilyInvoice['status'];
  student_id: string;
  total_amount: string;
  period_month: string;
  due_date: string;
  issued_at: Date;
  issued_cursor: string;
  transfer_note: string;
  qr_payload: string;
  payout: FamilyInvoice['payout'];
  voided_at: Date | null;
};

const COLS = sql`i.id, i.code, i.status, i.student_id, i.total_amount::text as total_amount,
  p.period_month::text as period_month, p.due_date::text as due_date, i.issued_at,
  to_char(i.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_cursor,
  i.transfer_note, i.qr_payload, i.payout, i.voided_at`;

/**
 * Phụ huynh đọc hóa đơn của các con (S5-BE-08, US-7.3 AC1). Không lọc theo tenant: phụ huynh có con ở nhiều giáo viên.
 * Tên con/giáo viên lấy qua `app_private.family_students()` (phụ huynh không có quyền đọc students/tenants); hóa đơn, kỳ
 * và dòng đọc trực tiếp dưới RLS `*_parent_read` (không nháp, chỉ con đã liên kết) và lọc lại theo danh sách con ở đây.
 * Con đã `left` không có trong `family_students()` nên hóa đơn của con đó không còn hiện (như mọi endpoint `/family`).
 */
@Injectable()
export class FamilyInvoicesService {
  constructor(
    private readonly tx: TxService,
    private readonly consents: ConsentsService,
  ) {}

  async list(
    userId: string,
    q: FamilyInvoicesQuery,
  ): Promise<FamilyInvoiceList> {
    await this.consents.assertAccepted(userId, 'parent');
    let after: ReturnType<typeof decodeInvoiceCursor>;
    try {
      after = decodeInvoiceCursor(q.cursor);
    } catch (e) {
      if (!(e instanceof InvalidCursorError)) throw e;
      throw new AppException('VALIDATION_FAILED', undefined, {
        cursor: ['Con trỏ không hợp lệ'],
      });
    }
    return this.tx.run({ userId }, async (t) => {
      const children = await this.children(t);
      const ids = q.studentId
        ? children.has(q.studentId)
          ? [q.studentId]
          : []
        : [...children.keys()];
      if (!ids.length) return { items: [], nextCursor: null };
      const rows = (
        await t.execute<Row>(sql`
          select ${COLS}
            from invoices i join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
           where i.status <> 'draft' and i.student_id in (${uuidList(ids)})
             ${q.status ? sql`and i.status = ${q.status}` : sql``}
             ${after ? sql`and (i.issued_at, i.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
           order by i.issued_at desc, i.id desc
           limit ${q.limit + 1}`)
      ).rows;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const tz = await this.timezones(t, page);
      return {
        items: page.map((r) => this.summary(r, children, tz)),
        nextCursor:
          rows.length > q.limit && last
            ? encodeInvoiceCursor(last.issued_cursor, last.id)
            : null,
      };
    });
  }

  async get(userId: string, id: string): Promise<FamilyInvoice> {
    await this.consents.assertAccepted(userId, 'parent');
    return this.tx.run({ userId }, async (t) => {
      const children = await this.children(t);
      if (!children.size) throw new AppException('NOT_FOUND');
      const [r] = (
        await t.execute<Row>(sql`
          select ${COLS}
            from invoices i join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
           where i.id = ${id}::uuid and i.status <> 'draft' and i.student_id in (${uuidList([...children.keys()])})`)
      ).rows;
      // Của con khác, tenant khác, nháp, con đã gỡ hay không tồn tại → cùng 404.
      if (!r) throw new AppException('NOT_FOUND');
      const lines = (
        await t.execute<{
          kind: FamilyInvoice['lines'][number]['kind'];
          class_name: string | null;
          description: string;
          amount: string;
        }>(sql`
          select l.kind, l.class_name, l.description, l.amount::text as amount
            from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
           where i.id = ${id}::uuid
           order by l.position`)
      ).rows;
      const tz = await this.timezones(t, [r]);
      const zone = tz.get(r.student_id)!;
      const void_ = r.status === 'void';
      return {
        ...this.summary(r, children, tz),
        lines: lines.map((l) => ({
          kind: l.kind,
          className: l.class_name,
          description: l.description,
          amount: Number(l.amount),
        })),
        transferNote: r.transfer_note,
        qrPayload: void_ ? null : r.qr_payload,
        payout: void_ || !r.payout ? null : pickPayout(r.payout),
        voidedAt: r.voided_at
          ? formatInZone(new Date(r.voided_at), zone)
          : null,
      };
    });
  }

  private async children(t: Tx): Promise<Map<string, Child>> {
    const rows = (
      await t.execute<{
        student_id: string;
        full_name: string;
        teacher_name: string;
      }>(
        sql`select student_id, full_name, teacher_name from app_private.family_students()`,
      )
    ).rows;
    return new Map(
      rows.map((r) => [
        r.student_id,
        { name: r.full_name, teacher: r.teacher_name },
      ]),
    );
  }

  private async timezones(t: Tx, rows: Row[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const sid of new Set(rows.map((r) => r.student_id))) {
      const r = await t.execute<{ timezone: string }>(
        sql`select timezone from app_private.family_student_timezone(${sid}::uuid)`,
      );
      out.set(sid, r.rows[0]?.timezone ?? 'Asia/Ho_Chi_Minh');
    }
    return out;
  }

  private summary(
    r: Row,
    children: Map<string, Child>,
    tz: Map<string, string>,
  ) {
    const c = children.get(r.student_id)!;
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      studentId: r.student_id,
      studentName: c.name,
      teacherName: c.teacher,
      periodMonth: r.period_month,
      totalAmount: Number(r.total_amount),
      dueDate: r.due_date,
      issuedAt: formatInZone(new Date(r.issued_at), tz.get(r.student_id)!),
    };
  }
}
