import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppException, MAX_VND, uuidv7 } from '@teachhub/core';
import {
  invoices,
  payments,
  recordOutboxEvent,
  revenueLedger,
  studentLedger,
  tenants,
  type Tx,
  users,
  writeAudit,
} from '@teachhub/db';
import { formatInZone, localDate } from '@teachhub/modules/schedule';
import type {
  Payment,
  PaymentList,
  PaymentResult,
  RecordPaymentRequest,
  VoidPaymentRequest,
} from '../http/payments.schemas.js';
import {
  isPayable,
  overpaidOf,
  overpaymentDelta,
  PAYMENT_RECORDED,
  type PaymentRecordedPayload,
  remainingOf,
  statusAfter,
} from '../domain/payment.js';
import type { Actor } from './billing.service.js';
import { DunningService } from './dunning.service.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

type InvoiceRow = typeof invoices.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

/**
 * Thu tiền (S6-BE-02, US-7.4, US-9.5 AC1). Mọi thao tác khóa hàng hóa đơn `FOR UPDATE` trước khi đọc/ghi số đã thu, nên hai
 * request song song cùng hóa đơn nối đuôi nhau (request sau đọc lại số đã commit). Mọi truy vấn lọc `tenant_id` tường minh,
 * RLS là lớp thứ hai; id của tenant khác → 404. Không log ghi chú hay lý do (văn bản tự do của giáo viên).
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly dunning: DunningService) {}

  async record(
    tx: Tx,
    actor: Actor,
    invoiceId: string,
    body: RecordPaymentRequest,
  ): Promise<PaymentResult> {
    const { tenantId } = actor;
    const inv = await this.lockInvoice(tx, tenantId, invoiceId);
    // Hóa đơn đã chuyển nợ một phần vẫn thu được phần còn lại (total − paid − carried); hết còn nợ thì không nhận thêm.
    const remaining = remainingOf(
      inv.totalAmount,
      inv.paidAmount,
      inv.carriedAmount,
    );
    if (!isPayable(inv.status) || (inv.carriedAmount > 0 && remaining === 0))
      throw new AppException('INVOICE_NOT_PAYABLE');
    // Ràng buộc DB: đã thu + đã chuyển ≤ tổng; kiểm trước để trả 422 thay vì lỗi 23514.
    if (inv.carriedAmount > 0 && body.amount > remaining)
      throw new AppException('VALIDATION_FAILED', undefined, {
        amount: [
          'Hóa đơn đã chuyển một phần nợ sang kỳ sau: chỉ thu tối đa phần còn nợ.',
        ],
      });
    const tz = await this.timezone(tx, tenantId);
    const today = localDate(new Date(), tz);
    const paidOn = body.paidOn ?? today;
    // Ngày thu trong [ngày phát hành theo múi giờ tenant, hôm nay]; so chuỗi ISO nên năm 0000 cũng bị chặn trước khi tới CSDL.
    const issuedOn = localDate(inv.issuedAt!, tz);
    if (paidOn > today || paidOn < issuedOn)
      throw new AppException('VALIDATION_FAILED', undefined, {
        paidOn: ['Ngày thu phải từ ngày phát hành hóa đơn đến hôm nay.'],
      });
    const paidAmount = inv.paidAmount + body.amount;
    if (paidAmount > MAX_VND)
      throw new AppException('VALIDATION_FAILED', undefined, {
        amount: ['Tổng đã thu vượt giới hạn cho phép.'],
      });

    const [row] = await tx
      .insert(payments)
      .values({
        id: uuidv7(),
        tenantId,
        invoiceId,
        amount: body.amount,
        method: body.method,
        paidOn,
        note: body.note || null,
        recordedBy: actor.userId,
        recordedByName: await this.displayName(tx, actor.userId),
      })
      .returning();
    const p = row!;
    await tx.insert(revenueLedger).values({
      id: uuidv7(),
      tenantId,
      paymentId: p.id,
      kind: 'payment',
      amount: p.amount,
      entryDate: p.paidOn,
      fiscalYear: yearOf(p.paidOn),
    });
    const delta = overpaymentDelta(inv.totalAmount, inv.paidAmount, paidAmount);
    if (delta > 0)
      await tx.insert(studentLedger).values({
        id: uuidv7(),
        tenantId,
        studentId: inv.studentId,
        invoiceId,
        paymentId: p.id,
        kind: 'overpayment',
        credit: delta,
        description: `Trả thừa hóa đơn ${inv.code}`,
      });

    const status = statusAfter(inv.totalAmount, paidAmount);
    await this.setPaid(tx, tenantId, invoiceId, status, paidAmount);
    // Hết nợ thì hủy các mốc nhắc chưa gửi (US-7.5 AC2); thu một phần vẫn nhắc số còn lại.
    // Race nhỏ: job nhắc đã chốt mốc (đọc nợ trước commit này) thì lời nhắc đó vẫn đi; notifier kiểm lại nợ lúc xử lý nên chỉ còn khe hẹp.
    const dunningCancelled =
      (await this.dunning.reconcile(tx, tenantId, [invoiceId])).cancelled > 0;
    const remainingAmount = remainingOf(
      inv.totalAmount,
      paidAmount,
      inv.carriedAmount,
    );
    await recordOutboxEvent(tx, {
      tenantId,
      type: PAYMENT_RECORDED,
      payload: {
        invoiceId,
        paymentId: p.id,
        studentId: inv.studentId,
        amount: p.amount,
        paidOn: p.paidOn,
        status: status as PaymentRecordedPayload['status'],
        remainingAmount,
      } satisfies PaymentRecordedPayload,
    });
    await writeAudit(tx, {
      tenantId,
      entity: 'payment',
      entityId: p.id,
      action: 'insert',
      before: null,
      after: {
        invoiceId,
        amount: p.amount,
        method: p.method,
        paidOn: p.paidOn,
        invoiceStatus: status,
        paidAmount,
      },
    });
    await writeAudit(tx, {
      tenantId,
      entity: 'invoice',
      entityId: invoiceId,
      action: 'update',
      before: { status: inv.status, paidAmount: inv.paidAmount },
      after: { status, paidAmount },
    });
    return this.result(
      p,
      tz,
      {
        status,
        paidAmount,
        total: inv.totalAmount,
        carried: inv.carriedAmount,
      },
      dunningCancelled,
    );
  }

  /** Danh sách mọi thanh toán của hóa đơn (kể cả đã hủy), mới ghi trước; bản nháp → 404. */
  async list(
    tx: Tx,
    tenantId: string,
    invoiceId: string,
  ): Promise<PaymentList> {
    const [inv] = await tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)));
    if (!inv || inv.status === 'draft') throw new AppException('NOT_FOUND');
    const rows = await tx
      .select()
      .from(payments)
      .where(
        and(eq(payments.tenantId, tenantId), eq(payments.invoiceId, invoiceId)),
      )
      .orderBy(desc(payments.recordedAt), desc(payments.id));
    const tz = await this.timezone(tx, tenantId);
    return { items: rows.map((r) => toPayment(r, tz)) };
  }

  /**
   * Hủy thanh toán (US-7.4 AC4): đặt `voided_*`, bút toán đảo ở hai sổ, tính lại trạng thái từ Σ còn hiệu lực. Đã hủy → trả
   * bản hiện tại, giữ lý do và người hủy đầu tiên, không ghi bút toán thứ hai.
   */
  async void(
    tx: Tx,
    actor: Actor,
    paymentId: string,
    body: VoidPaymentRequest,
  ): Promise<PaymentResult> {
    const { tenantId } = actor;
    const [found] = await tx
      .select({ invoiceId: payments.invoiceId })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)));
    if (!found) throw new AppException('NOT_FOUND');
    const inv = await this.lockInvoice(tx, tenantId, found.invoiceId);
    const tz = await this.timezone(tx, tenantId);
    // Đọc lại sau khi giữ khóa: request hủy song song đã commit thì thấy `voided_at`.
    const [p] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)));
    if (p!.voidedAt)
      return this.result(p!, tz, {
        status: inv.status,
        paidAmount: inv.paidAmount,
        total: inv.totalAmount,
        carried: inv.carriedAmount,
      });

    const [voided] = await tx
      .update(payments)
      .set({
        voidedAt: sql`now()`,
        voidReason: body.reason,
        voidedBy: actor.userId,
        voidedByName: await this.displayName(tx, actor.userId),
      })
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .returning();
    // Dòng đảo mang ngày và năm của dòng thu gốc: hủy là sửa sai, doanh thu năm đó không còn khoản này.
    await tx.insert(revenueLedger).values({
      id: uuidv7(),
      tenantId,
      paymentId,
      kind: 'reversal',
      amount: -p!.amount,
      entryDate: p!.paidOn,
      fiscalYear: yearOf(p!.paidOn),
    });
    const paidAmount = inv.paidAmount - p!.amount;
    const delta = overpaymentDelta(inv.totalAmount, inv.paidAmount, paidAmount);
    if (delta < 0)
      await tx.insert(studentLedger).values({
        id: uuidv7(),
        tenantId,
        studentId: inv.studentId,
        invoiceId: inv.id,
        paymentId,
        kind: 'payment_void',
        debit: -delta,
        description: `Hủy thanh toán, đảo phần trả thừa hóa đơn ${inv.code}`,
      });
    // Hủy không đổi trạng thái chờ xác nhận (US-7.7); trạng thái khác suy từ Σ còn hiệu lực.
    const status =
      inv.status === 'pending_confirmation'
        ? inv.status
        : statusAfter(inv.totalAmount, paidAmount);
    await this.setPaid(tx, tenantId, inv.id, status, paidAmount);
    // Còn nợ trở lại thì lập lại các mốc chưa qua đã hủy vì thu đủ.
    await this.dunning.reconcile(tx, tenantId, [inv.id], ['settled']);
    await writeAudit(tx, {
      tenantId,
      entity: 'payment',
      entityId: paymentId,
      action: 'update',
      before: { voidedAt: null },
      after: { voidedAt: voided!.voidedAt, reason: body.reason, paidAmount },
    });
    await writeAudit(tx, {
      tenantId,
      entity: 'invoice',
      entityId: inv.id,
      action: 'update',
      before: { status: inv.status, paidAmount: inv.paidAmount },
      after: { status, paidAmount },
    });
    return this.result(voided!, tz, {
      status,
      paidAmount,
      total: inv.totalAmount,
      carried: inv.carriedAmount,
    });
  }

  private async lockInvoice(
    tx: Tx,
    tenantId: string,
    id: string,
  ): Promise<InvoiceRow> {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, id)))
      .for('update');
    if (!row) throw new AppException('NOT_FOUND');
    return row;
  }

  private async setPaid(
    tx: Tx,
    tenantId: string,
    id: string,
    status: string,
    paidAmount: number,
  ) {
    await tx
      .update(invoices)
      .set({ status, paidAmount })
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, id)));
  }

  private async timezone(tx: Tx, tenantId: string): Promise<string> {
    const [t] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return t?.tz ?? DEFAULT_TZ;
  }

  private result(
    p: PaymentRow,
    tz: string,
    s: { status: string; paidAmount: number; total: number; carried: number },
    dunningCancelled = false,
  ): PaymentResult {
    return {
      payment: toPayment(p, tz),
      status: s.status as PaymentResult['status'],
      paidAmount: s.paidAmount,
      remainingAmount: remainingOf(s.total, s.paidAmount, s.carried),
      overpaidAmount: overpaidOf(s.total, s.paidAmount),
      dunningCancelled,
    };
  }

  /** Tên hiển thị của người thao tác (dòng `users` của chính họ): chụp vào payments lúc ghi/hủy. */
  private async displayName(tx: Tx, userId: string): Promise<string> {
    const [u] = await tx
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    return u?.name ?? '';
  }
}

const yearOf = (date: string) => Number(date.slice(0, 4));

export const toPayment = (r: PaymentRow, tz: string): Payment => {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    amount: r.amount,
    method: r.method as Payment['method'],
    paidOn: r.paidOn,
    note: r.note,
    recordedAt: formatInZone(r.recordedAt, tz),
    recordedBy: { id: r.recordedBy, name: r.recordedByName },
    voidedAt: r.voidedAt ? formatInZone(r.voidedAt, tz) : null,
    voidedBy:
      r.voidedBy && r.voidedByName !== null
        ? { id: r.voidedBy, name: r.voidedByName }
        : null,
    voidReason: r.voidReason,
  };
};
