import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppException } from '@teachhub/core';
import {
  invoices,
  paymentClaims,
  recordOutboxEvent,
  tenants,
  type Tx,
  users,
  writeAudit,
} from '@teachhub/db';
import { ConsentsService } from '@teachhub/modules/identity';
import { formatInZone } from '@teachhub/modules/schedule';
import {
  PAYMENT_CLAIM_REJECTED,
  type PaymentClaimEventPayload,
} from '../domain/payment-claim.js';
import { statusAfter } from '../domain/payment.js';
import type {
  CreatePaymentClaimRequest,
  PaymentClaim,
  PaymentClaimList,
  ResolvePaymentClaimRequest,
  ResolvePaymentClaimResult,
} from '../http/payment-claims.schemas.js';
import type { Actor } from './billing.service.js';
import { DunningService } from './dunning.service.js';
import { PaymentsService } from './payments.service.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

type ClaimRow = typeof paymentClaims.$inferSelect;

const toClaim = (r: ClaimRow, tz: string): PaymentClaim => ({
  id: r.id,
  invoiceId: r.invoiceId,
  status: r.status as PaymentClaim['status'],
  amount: r.amount,
  note: r.note,
  receiptFileId: r.receiptFileId,
  claimedBy: { id: r.claimedBy, name: r.claimedByName },
  createdAt: formatInZone(r.createdAt, tz),
  resolvedAt: r.resolvedAt ? formatInZone(r.resolvedAt, tz) : null,
  resolvedBy:
    r.resolvedBy && r.resolvedByName !== null
      ? { id: r.resolvedBy, name: r.resolvedByName }
      : null,
  rejectReason: r.rejectReason,
  paymentId: r.paymentId,
});

interface CreateResult {
  result: 'ok' | 'not_found' | 'not_payable' | 'pending_exists' | 'bad_file';
  claimId?: string;
  timezone?: string;
}

/**
 * Phụ huynh báo đã chuyển khoản và giáo viên xử lý (S8-BE-claims, US-7.7). Tạo đi qua hàm CSDL `app_private.create_payment_claim`
 * (security definer: phụ huynh không có quyền đổi hóa đơn/nhắc nợ; hàm tự kiểm người giám hộ, tệp, trạng thái, khóa hóa đơn).
 * Xử lý (`resolve`) khóa hóa đơn TRƯỚC lần báo (cùng thứ tự với hàm tạo) rồi `confirm` đi đúng đường `PaymentsService.record`
 * (payments + revenue_ledger + student_ledger + outbox `payment_recorded` trong CÙNG giao dịch, nên Σ hóa đơn/thanh toán/sổ vẫn
 * khớp `billing.reconcile`). Không log ghi chú/lý do (văn bản tự do). Id của tenant khác → 404.
 */
@Injectable()
export class PaymentClaimsService {
  constructor(
    private readonly payments: PaymentsService,
    private readonly dunning: DunningService,
    private readonly consents: ConsentsService,
  ) {}

  async create(
    t: Tx,
    userId: string,
    invoiceId: string,
    body: CreatePaymentClaimRequest,
  ): Promise<PaymentClaim> {
    await this.consents.assertAccepted(userId, 'parent');
    const r = (
      await t.execute<{ r: CreateResult }>(sql`
        select app_private.create_payment_claim(${invoiceId}::uuid, ${body.receiptFileId}::uuid,
          ${body.amount ?? null}::bigint, ${body.note ?? null}::text) as r`)
    ).rows[0]!.r;
    switch (r.result) {
      case 'not_found':
        throw new AppException('NOT_FOUND');
      case 'not_payable':
        throw new AppException('INVOICE_NOT_PAYABLE');
      case 'pending_exists':
        throw new AppException('CONFLICT_STALE');
      case 'bad_file':
        throw new AppException('VALIDATION_FAILED', undefined, {
          receiptFileId: [
            'Biên lai phải là tệp đã tải lên xong của chính bạn cho hóa đơn này và chưa dùng cho lần báo khác.',
          ],
        });
    }
    const [row] = await t
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.id, r.claimId!));
    return toClaim(row!, r.timezone ?? DEFAULT_TZ);
  }

  async list(
    tx: Tx,
    tenantId: string,
    invoiceId: string,
  ): Promise<PaymentClaimList> {
    const [inv] = await tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)));
    if (!inv || inv.status === 'draft') throw new AppException('NOT_FOUND');
    const rows = await tx
      .select()
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.tenantId, tenantId),
          eq(paymentClaims.invoiceId, invoiceId),
        ),
      )
      .orderBy(desc(paymentClaims.createdAt), desc(paymentClaims.id));
    const tz = await this.timezone(tx, tenantId);
    return { items: rows.map((r) => toClaim(r, tz)) };
  }

  async resolve(
    tx: Tx,
    actor: Actor,
    claimId: string,
    body: ResolvePaymentClaimRequest,
  ): Promise<ResolvePaymentClaimResult> {
    const { tenantId, userId } = actor;
    const [found] = await tx
      .select({ invoiceId: paymentClaims.invoiceId })
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.tenantId, tenantId),
          eq(paymentClaims.id, claimId),
        ),
      );
    if (!found) throw new AppException('NOT_FOUND');
    // Thứ tự khóa: hóa đơn rồi lần báo (hàm tạo khóa hóa đơn trước khi chèn lần báo): không có vòng chờ.
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.tenantId, tenantId), eq(invoices.id, found.invoiceId)),
      )
      .for('update');
    const [claim] = await tx
      .select()
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.tenantId, tenantId),
          eq(paymentClaims.id, claimId),
        ),
      )
      .for('update');
    if (!inv || !claim) throw new AppException('NOT_FOUND');
    if (claim.status !== 'pending' || inv.status === 'void')
      throw new AppException('CONFLICT_STALE');
    const tz = await this.timezone(tx, tenantId);
    const name = await this.displayName(tx, userId);
    const resolved = {
      resolvedAt: sql`now()`,
      resolvedBy: userId,
      resolvedByName: name,
    };

    if (body.decision === 'confirm') {
      const result = await this.payments.record(tx, actor, inv.id, {
        amount: body.amount ?? claim.amount,
        method: 'bank_transfer',
        paidOn: body.paidOn,
      });
      const [done] = await tx
        .update(paymentClaims)
        .set({ status: 'confirmed', paymentId: result.payment.id, ...resolved })
        .where(eq(paymentClaims.id, claimId))
        .returning();
      // Thu một phần: còn nợ thì các mốc nhắc đã tạm dừng khi báo được lập lại (thu đủ thì không còn đáng nhắc).
      await this.dunning.reconcile(tx, tenantId, [inv.id], ['claim_pending']);
      return { claim: toClaim(done!, tz), result };
    }

    const [done] = await tx
      .update(paymentClaims)
      .set({ status: 'rejected', rejectReason: body.reason, ...resolved })
      .where(eq(paymentClaims.id, claimId))
      .returning();
    // Chỉ trả về trạng thái trước khi báo nếu hóa đơn vẫn chờ xác nhận; giáo viên đã ghi thu trực tiếp giữa chừng thì giữ trạng thái đó.
    if (inv.status === 'pending_confirmation') {
      const status = statusAfter(inv.totalAmount, inv.paidAmount);
      await tx
        .update(invoices)
        .set({ status })
        .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, inv.id)));
      await writeAudit(tx, {
        tenantId,
        entity: 'invoice',
        entityId: inv.id,
        action: 'update',
        before: { status: inv.status, paidAmount: inv.paidAmount },
        after: { status, paidAmount: inv.paidAmount, paymentClaimId: claimId },
      });
    }
    await this.dunning.reconcile(tx, tenantId, [inv.id], ['claim_pending']);
    await recordOutboxEvent(tx, {
      tenantId,
      type: PAYMENT_CLAIM_REJECTED,
      payload: {
        claimId,
        invoiceId: inv.id,
      } satisfies PaymentClaimEventPayload,
    });
    return { claim: toClaim(done!, tz), result: null };
  }

  private async timezone(tx: Tx, tenantId: string): Promise<string> {
    const [t] = await tx
      .select({ tz: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return t?.tz ?? DEFAULT_TZ;
  }

  private async displayName(tx: Tx, userId: string): Promise<string> {
    const [u] = await tx
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    return u?.name ?? '';
  }
}
