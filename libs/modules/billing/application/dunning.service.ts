import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import {
  billingPeriods,
  dunningJobs,
  enrollments,
  invoices,
  tenants,
  type Tx,
  writeAudit,
} from '@teachhub/db';
import { formatInZone, zonedToInstant } from '@teachhub/modules/schedule';
import {
  type DunningPreview,
  type DunningPreviewQuery,
  type DunningSettings,
  type EnrollmentDunningResult,
  type InvoiceDunning,
  type UpdateDunningSettingsRequest,
} from '../http/dunning.schemas.js';
import {
  isDunnable,
  parseDunningSettings,
  reminderCopy,
  SEND_TIME,
} from '../domain/dunning.js';
import { addDays } from '../domain/billing-period.js';
import type { Actor } from './billing.service.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';
const CHUNK = 1000;

type Reason = 'settled' | 'void' | 'student_disabled' | 'tenant_disabled';
type JobRow = typeof dunningJobs.$inferSelect;

interface InvoiceFacts {
  id: string;
  studentId: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  carriedAmount: number;
  dueDate: string;
}

/**
 * Nhắc nợ (S6-BE-04, US-7.5): cài đặt tenant, lập lịch khi phát hành, hủy/lập lại theo trạng thái hóa đơn, tắt theo học viên.
 * Mọi truy vấn lọc `tenant_id` tường minh, RLS là lớp thứ hai; id của tenant khác → 404. Một hàm duy nhất (`reconcile`) quyết
 * định hóa đơn còn được nhắc không, nên thu tiền, hủy hóa đơn, kết chuyển nợ và bật/tắt đều đi chung một luật.
 * shortcut: giờ gửi cố định 09:00 giờ tenant (khung gửi 07:00–21:30 do job kiểm), chưa cấu hình riêng; giờ yên lặng chung (US-6.5) chưa có.
 */
@Injectable()
export class DunningService {
  // ---- cài đặt tenant ----

  async getSettings(tx: Tx, tenantId: string): Promise<DunningSettings> {
    return (await this.tenant(tx, tenantId)).settings;
  }

  /** Thay toàn bộ. Tắt (đang bật → tắt) hủy lời nhắc chưa gửi của mọi hóa đơn; bật lại không lập lại cho hóa đơn cũ. */
  async putSettings(
    tx: Tx,
    actor: Actor,
    body: UpdateDunningSettingsRequest,
  ): Promise<DunningSettings> {
    const { tenantId } = actor;
    const before = (await this.tenant(tx, tenantId, true)).settings;
    const next = { enabled: body.enabled, offsetsDays: body.offsetsDays };
    await tx
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{dunning}', ${JSON.stringify(next)}::jsonb)`,
      })
      .where(eq(tenants.id, tenantId));
    if (before.enabled && !next.enabled)
      await this.cancelPending(
        tx,
        eq(dunningJobs.tenantId, tenantId),
        'tenant_disabled',
      );
    await writeAudit(tx, {
      tenantId,
      entity: 'dunning_settings',
      entityId: tenantId,
      action: 'update',
      before,
      after: next,
    });
    return next;
  }

  /** Tin mẫu bằng dữ liệu giả; không gửi gì. */
  preview(q: DunningPreviewQuery): DunningPreview {
    const { title, body } = reminderCopy({
      offsetDays: q.offsetDays,
      remainingAmount: 700_000,
      dueDate: '2027-01-10',
      code: 'TH-25K7Q9',
    });
    return { offsetDays: q.offsetDays, title, body };
  }

  // ---- vòng đời lời nhắc của hóa đơn ----

  /** Lập lịch cho hóa đơn vừa phát hành: mốc theo lịch tenant, bỏ mốc đã qua; tenant/học viên tắt nhắc hoặc 0 đ thì không lập. */
  async scheduleIssued(
    tx: Tx,
    tenantId: string,
    invoiceIds: string[],
  ): Promise<void> {
    if (!invoiceIds.length) return;
    const { settings, tz } = await this.tenant(tx, tenantId);
    if (!settings.enabled) return;
    const facts = await this.facts(tx, tenantId, invoiceIds);
    const off = await this.disabledStudents(tx, tenantId, facts);
    await this.insertSteps(
      tx,
      tenantId,
      facts.filter((f) => isDunnable(f) && !off.has(f.studentId)),
      settings.offsetsDays,
      tz,
    );
  }

  /**
   * Job gọi mỗi lượt (M1): hóa đơn còn nợ thật, nhắc được, tenant và học viên bật nhắc mà CHƯA có dòng `dunning_jobs` nào
   * (phát hành trước migration 0028, hoặc lúc đó tenant/học viên tắt nhắc rồi bật lại) được lập các mốc tương lai theo lịch
   * tenant hiện hành; không tạo mốc quá khứ nên không gửi dồn. Trả số hóa đơn được lập.
   * shortcut: hóa đơn mà mọi mốc đều đã qua không có dòng nào nên bị quét lại mỗi lượt (rẻ nhờ `invoices_debt_idx`); đánh dấu
   * hóa đơn "đã lập lịch" khi số hóa đơn mở đủ lớn để quét này đáng kể.
   */
  async scheduleMissing(tx: Tx, tenantId: string): Promise<number> {
    const { settings, tz } = await this.tenant(tx, tenantId);
    if (!settings.enabled) return 0;
    const ids = (
      await tx.execute<{ id: string }>(sql`
        select i.id from invoices i
        where i.tenant_id = ${tenantId} and i.status in ('issued', 'partially_paid')
          and i.total_amount - i.paid_amount - i.carried_amount > 0
          and not exists (select 1 from dunning_jobs d where d.tenant_id = i.tenant_id and d.invoice_id = i.id)`)
    ).rows.map((r) => r.id);
    if (!ids.length) return 0;
    const facts = (await this.facts(tx, tenantId, ids)).filter(isDunnable);
    const off = await this.disabledStudents(tx, tenantId, facts);
    const list = facts.filter((f) => !off.has(f.studentId));
    await this.insertSteps(tx, tenantId, list, settings.offsetsDays, tz);
    return list.length;
  }

  /**
   * Đưa lời nhắc của các hóa đơn về đúng trạng thái hiện tại (gọi sau khi đổi số đã thu, hủy hóa đơn, kết chuyển nợ, bật/tắt).
   * Không còn đáng nhắc → hủy mốc `pending` (kèm lý do). Còn đáng nhắc → lập lại mốc chưa tới đã hủy vì một trong `revive`
   * (vd. `settled` khi hủy thanh toán). Trả số mốc vừa hủy / lập lại.
   */
  async reconcile(
    tx: Tx,
    tenantId: string,
    invoiceIds: string[],
    revive: Reason[] = [],
  ): Promise<{ cancelled: number; revived: number }> {
    const out = { cancelled: 0, revived: 0 };
    if (!invoiceIds.length) return out;
    const { settings, tz } = await this.tenant(tx, tenantId);
    const facts = await this.facts(tx, tenantId, invoiceIds);
    const off = await this.disabledStudents(tx, tenantId, facts);
    const reasonOf = (f: InvoiceFacts): Reason | null =>
      f.status === 'void'
        ? 'void'
        : !isDunnable(f)
          ? 'settled'
          : !settings.enabled
            ? 'tenant_disabled'
            : off.has(f.studentId)
              ? 'student_disabled'
              : null;
    const live: InvoiceFacts[] = [];
    for (const reason of [
      'void',
      'settled',
      'tenant_disabled',
      'student_disabled',
    ] as const) {
      const ids = facts.filter((f) => reasonOf(f) === reason).map((f) => f.id);
      if (ids.length)
        out.cancelled += await this.cancelPending(
          tx,
          and(
            eq(dunningJobs.tenantId, tenantId),
            inArray(dunningJobs.invoiceId, ids),
          ),
          reason,
        );
    }
    for (const f of facts) if (reasonOf(f) === null) live.push(f);
    if (!live.length) return out;
    const liveIds = live.map((f) => f.id);
    if (revive.length)
      out.revived = (
        await tx
          .update(dunningJobs)
          .set({ status: 'pending', cancelReason: null })
          .where(
            and(
              eq(dunningJobs.tenantId, tenantId),
              inArray(dunningJobs.invoiceId, liveIds),
              eq(dunningJobs.status, 'cancelled'),
              inArray(dunningJobs.cancelReason, revive),
              gt(dunningJobs.scheduledFor, new Date()),
            ),
          )
          .returning({ id: dunningJobs.id })
      ).length;
    // Hóa đơn chưa từng có mốc (phát hành trước 0028, hoặc lúc nhắc đang tắt) do `scheduleMissing` của job lập ở lượt sau.
    return out;
  }

  // ---- theo học viên ----

  async setEnrollment(
    tx: Tx,
    actor: Actor,
    enrollmentId: string,
    enabled: boolean,
  ): Promise<EnrollmentDunningResult> {
    const { tenantId } = actor;
    const [enr] = await tx
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.id, enrollmentId),
        ),
      )
      .for('update');
    if (!enr) throw new AppException('NOT_FOUND');
    if (enr.leftOn) throw new AppException('CONFLICT_STALE');
    const studentId = enr.studentId;
    const wasEnabled = await this.studentEnabled(tx, tenantId, studentId);
    let cancelledCount = 0;
    if (enr.dunningEnabled !== enabled) {
      await tx
        .update(enrollments)
        .set({ dunningEnabled: enabled })
        .where(
          and(
            eq(enrollments.tenantId, tenantId),
            eq(enrollments.id, enrollmentId),
          ),
        );
      await writeAudit(tx, {
        tenantId,
        entity: 'enrollment_dunning',
        entityId: enrollmentId,
        action: 'update',
        before: { enabled: enr.dunningEnabled },
        after: { enabled },
      });
      const nowEnabled = await this.studentEnabled(tx, tenantId, studentId);
      if (nowEnabled !== wasEnabled) {
        const open = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, tenantId),
              eq(invoices.studentId, studentId),
              inArray(invoices.status, ['issued', 'partially_paid']),
            ),
          )
          .orderBy(asc(invoices.id));
        const r = await this.reconcile(
          tx,
          tenantId,
          open.map((o) => o.id),
          nowEnabled ? ['student_disabled'] : [],
        );
        cancelledCount = r.cancelled;
      }
    }
    return {
      enrollmentId,
      studentId,
      enabled,
      studentDunningEnabled: await this.studentEnabled(tx, tenantId, studentId),
      cancelledCount,
    };
  }

  /**
   * Học viên được nhắc khi còn ít nhất một ghi danh đang mở bật nhắc; không còn ghi danh mở nào (đã rời hết lớp) thì vẫn nhắc,
   * vì không có công tắc nào để tắt.
   */
  async studentEnabled(
    tx: Tx,
    tenantId: string,
    studentId: string,
  ): Promise<boolean> {
    const off = await this.disabledStudents(tx, tenantId, [{ studentId }]);
    return !off.has(studentId);
  }

  // ---- đọc ----

  async forInvoice(
    tx: Tx,
    tenantId: string,
    invoiceId: string,
  ): Promise<InvoiceDunning> {
    const [f] = await this.facts(tx, tenantId, [invoiceId]);
    if (!f) throw new AppException('NOT_FOUND');
    const { settings, tz } = await this.tenant(tx, tenantId);
    const off = await this.disabledStudents(tx, tenantId, [f]);
    const draft = f.status === 'draft';
    const disabledReason =
      f.status === 'void'
        ? 'void'
        : !draft && !isDunnable(f)
          ? 'paid'
          : !settings.enabled
            ? 'tenant_disabled'
            : off.has(f.studentId)
              ? 'student_disabled'
              : null;
    const steps = await tx
      .select()
      .from(dunningJobs)
      .where(
        and(
          eq(dunningJobs.tenantId, tenantId),
          eq(dunningJobs.invoiceId, invoiceId),
        ),
      )
      .orderBy(asc(dunningJobs.scheduledFor), asc(dunningJobs.id));
    return {
      invoiceId,
      enabled: disabledReason === null,
      disabledReason,
      steps: steps.map((s) => toStep(s, tz)),
    };
  }

  /** Lịch sử nhắc của một học viên (mới nhất trước, tối đa 50) và công tắc từng ghi danh đang mở. */
  async studentView(tx: Tx, tenantId: string, studentId: string) {
    const { tz } = await this.tenant(tx, tenantId);
    const rows = await tx
      .select({ j: dunningJobs, code: invoices.code })
      .from(dunningJobs)
      .innerJoin(
        invoices,
        and(
          eq(invoices.tenantId, dunningJobs.tenantId),
          eq(invoices.id, dunningJobs.invoiceId),
        ),
      )
      .where(
        and(
          eq(dunningJobs.tenantId, tenantId),
          eq(invoices.studentId, studentId),
        ),
      )
      .orderBy(desc(dunningJobs.scheduledFor), desc(dunningJobs.id))
      .limit(50);
    return {
      enabled: await this.studentEnabled(tx, tenantId, studentId),
      reminders: rows.map((r) => ({
        invoiceId: r.j.invoiceId,
        invoiceCode: r.code,
        ...toStep(r.j, tz),
      })),
    };
  }

  // ---- nội bộ ----

  private async tenant(tx: Tx, tenantId: string, lock = false) {
    const q = tx
      .select({ tz: tenants.timezone, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const [t] = await (lock ? q.for('update') : q);
    return {
      tz: t?.tz ?? DEFAULT_TZ,
      settings: parseDunningSettings(t?.settings),
    };
  }

  private async facts(
    tx: Tx,
    tenantId: string,
    ids: string[],
  ): Promise<InvoiceFacts[]> {
    const out: InvoiceFacts[] = [];
    for (let i = 0; i < ids.length; i += CHUNK)
      out.push(
        ...(await tx
          .select({
            id: invoices.id,
            studentId: invoices.studentId,
            status: invoices.status,
            totalAmount: invoices.totalAmount,
            paidAmount: invoices.paidAmount,
            carriedAmount: invoices.carriedAmount,
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
              inArray(invoices.id, ids.slice(i, i + CHUNK)),
            ),
          )),
      );
    return out;
  }

  /** Học viên (trong `of`) có ghi danh đang mở và mọi ghi danh đó đều tắt nhắc. */
  private async disabledStudents(
    tx: Tx,
    tenantId: string,
    of: { studentId: string }[],
  ): Promise<Set<string>> {
    const ids = [...new Set(of.map((f) => f.studentId))];
    if (!ids.length) return new Set();
    const rows = await tx
      .select({ studentId: enrollments.studentId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          inArray(enrollments.studentId, ids),
          isNull(enrollments.leftOn),
        ),
      )
      .groupBy(enrollments.studentId)
      .having(sql`not bool_or(${enrollments.dunningEnabled})`);
    return new Set(rows.map((r) => r.studentId));
  }

  private async cancelPending(
    tx: Tx,
    where: SQL | undefined,
    reason: string,
  ): Promise<number> {
    return (
      await tx
        .update(dunningJobs)
        .set({ status: 'cancelled', cancelReason: reason })
        .where(and(where, eq(dunningJobs.status, 'pending')))
        .returning({ id: dunningJobs.id })
    ).length;
  }

  /** Chèn mốc chưa qua (`scheduled_for` > bây giờ); trùng (hóa đơn, mốc) bị bỏ qua. */
  private async insertSteps(
    tx: Tx,
    tenantId: string,
    list: InvoiceFacts[],
    offsets: number[],
    tz: string,
  ): Promise<void> {
    const now = Date.now();
    const rows: (typeof dunningJobs.$inferInsert)[] = [];
    for (const f of list)
      for (const offsetDays of offsets) {
        const scheduledFor = zonedToInstant(
          addDays(f.dueDate, offsetDays),
          SEND_TIME,
          tz,
        );
        if (scheduledFor.getTime() > now)
          rows.push({
            id: uuidv7(),
            tenantId,
            invoiceId: f.id,
            offsetDays,
            scheduledFor,
          });
      }
    for (let i = 0; i < rows.length; i += CHUNK)
      await tx
        .insert(dunningJobs)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoNothing({
          target: [dunningJobs.invoiceId, dunningJobs.offsetDays],
        });
  }
}

const toStep = (s: JobRow, tz: string) => ({
  offsetDays: s.offsetDays,
  scheduledFor: formatInZone(s.scheduledFor, tz),
  status: s.status as 'pending' | 'sent' | 'cancelled',
  sentAt: s.sentAt ? formatInZone(s.sentAt, tz) : null,
});
