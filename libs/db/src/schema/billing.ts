import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { students } from './students.js';
import { tenants } from './tenancy.js';

// Học phí và hóa đơn (Technical Spec §4.3, §4.4; S5-BE-01, S5-BE-04). Tiền là bigint đồng, trần 100 tỷ.
// RLS, FORCE, trigger bất biến hóa đơn và policy phụ huynh viết tay cuối migration billing.
// Không bật audit trigger ở DB cho payout_accounts/invoices: to_jsonb sẽ chép số tài khoản vào audit_logs.
// Service ghi audit qua app_private.audit_insert (writeAudit) với before/after đã che số tài khoản.

const MAX_VND = '100000000000';
const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

/** Tài khoản nhận tiền của tenant (≤ 5, giới hạn kiểm ở service). Hóa đơn phát hành chụp snapshot nên xóa cứng được. */
export const payoutAccounts = pgTable(
  'payout_accounts',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    bankBin: char({ length: 6 }).notNull(),
    accountNo: text().notNull(),
    accountName: text().notNull(),
    isPrimary: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('payout_accounts_tenant_id_id_uq').on(t.tenantId, t.id),
    uniqueIndex('payout_accounts_primary_uq')
      .on(t.tenantId)
      .where(sql`${t.isPrimary}`),
    check('payout_accounts_bank_bin_check', sql`${t.bankBin} ~ '^[0-9]{6}$'`),
    check(
      'payout_accounts_account_no_check',
      sql`${t.accountNo} ~ '^[0-9]{6,19}$'`,
    ),
    check(
      'payout_accounts_account_name_check',
      sql`char_length(trim(${t.accountName})) between 1 and 50`,
    ),
  ],
);

/** Kỳ thu theo tháng dương lịch: `period_month` là ngày 1. */
export const billingPeriods = pgTable(
  'billing_periods',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    periodMonth: date({ mode: 'string' }).notNull(),
    closeDate: date({ mode: 'string' }).notNull(),
    dueDate: date({ mode: 'string' }).notNull(),
    status: text().notNull().default('drafting'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('billing_periods_tenant_month_uq').on(t.tenantId, t.periodMonth),
    unique('billing_periods_tenant_id_id_uq').on(t.tenantId, t.id),
    check(
      'billing_periods_month_check',
      sql`${t.periodMonth} = date_trunc('month', ${t.periodMonth})::date`,
    ),
    check(
      'billing_periods_status_check',
      sql`${t.status} in ('drafting', 'closed')`,
    ),
  ],
);

/**
 * Một hóa đơn gộp mọi lớp của một học viên trong kỳ. `code`, `transfer_note`, `qr_payload`, `payout`, `issued_at`
 * chỉ có sau khi phát hành; từ đó tiền và snapshot bất biến (trigger invoices_guard).
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    periodId: uuid().notNull(),
    studentId: uuid().notNull(),
    status: text().notNull().default('draft'),
    code: text(),
    totalAmount: bigint({ mode: 'number' }).notNull().default(0),
    /** Phần âm bị cắt để total_amount không âm. */
    clampedAmount: bigint({ mode: 'number' }).notNull().default(0),
    installmentNo: integer(),
    installmentCount: integer(),
    transferNote: text(),
    qrPayload: text(),
    /** Snapshot { bankBin, bankName, accountNo, accountName } lúc phát hành. */
    payout: jsonb(),
    replacesInvoiceId: uuid(),
    replacementInvoiceId: uuid(),
    voidReason: text(),
    issuedAt: timestamp({ withTimezone: true }),
    voidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'invoices_tenant_period_fk',
      columns: [t.tenantId, t.periodId],
      foreignColumns: [billingPeriods.tenantId, billingPeriods.id],
    }),
    foreignKey({
      name: 'invoices_tenant_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'invoices_tenant_replaces_fk',
      columns: [t.tenantId, t.replacesInvoiceId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: 'invoices_tenant_replacement_fk',
      columns: [t.tenantId, t.replacementInvoiceId],
      foreignColumns: [t.tenantId, t.id],
    }),
    unique('invoices_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('invoices_tenant_code_uq').on(t.tenantId, t.code),
    // Chạy job chốt kỳ hai lần không sinh bản nháp trùng.
    uniqueIndex('invoices_draft_uq')
      .on(t.tenantId, t.periodId, t.studentId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex('invoices_replaces_uq')
      .on(t.replacesInvoiceId)
      .where(sql`${t.replacesInvoiceId} is not null`),
    index('invoices_tenant_period_status_idx').on(
      t.tenantId,
      t.periodId,
      t.status,
      t.id,
    ),
    index('invoices_replacement_id_idx')
      .on(t.replacementInvoiceId)
      .where(sql`${t.replacementInvoiceId} is not null`),
    // Danh sách hóa đơn của phụ huynh (phân trang con trỏ theo issued_at, id).
    index('invoices_family_idx')
      .on(t.studentId, t.issuedAt.desc(), t.id)
      .where(sql`${t.status} <> 'draft'`),
    index('invoices_student_id_idx').on(t.studentId),
    check(
      'invoices_status_check',
      sql`${t.status} in ('draft', 'issued', 'pending_confirmation', 'partially_paid', 'paid', 'void')`,
    ),
    check(
      'invoices_total_amount_check',
      sql`${t.totalAmount} >= 0 and ${t.totalAmount} <= ${sql.raw(MAX_VND)}`,
    ),
    check(
      'invoices_clamped_amount_check',
      sql`${t.clampedAmount} >= 0 and ${t.clampedAmount} <= ${sql.raw(MAX_VND)}`,
    ),
    check('invoices_code_check', sql`${t.code} ~ '^TH-[0-9A-HJKMNP-TV-Z]{6}$'`),
    check(
      'invoices_transfer_note_check',
      sql`${t.transferNote} ~ '^TH [0-9A-HJKMNP-TV-Z]{6}$'`,
    ),
    check('invoices_qr_payload_check', sql`char_length(${t.qrPayload}) <= 512`),
    check(
      'invoices_installment_check',
      sql`(${t.installmentNo} is null) = (${t.installmentCount} is null)
        and (${t.installmentNo} is null or (${t.installmentCount} between 1 and 36 and ${t.installmentNo} between 1 and ${t.installmentCount}))`,
    ),
    // Bản nháp chưa có gì của phát hành; từ `issued` trở đi phải đủ mã, nội dung chuyển khoản, QR, snapshot, giờ phát hành.
    check(
      'invoices_issue_fields_check',
      sql`case when ${t.status} = 'draft'
        then ${t.code} is null and ${t.transferNote} is null and ${t.qrPayload} is null and ${t.payout} is null and ${t.issuedAt} is null
        else ${t.code} is not null and ${t.transferNote} is not null and ${t.qrPayload} is not null and ${t.payout} is not null and ${t.issuedAt} is not null end`,
    ),
    check(
      'invoices_void_fields_check',
      sql`(${t.status} = 'void') = (${t.voidedAt} is not null and ${t.voidReason} is not null)
        and (${t.status} = 'void' or (${t.voidedAt} is null and ${t.voidReason} is null))`,
    ),
    check(
      'invoices_void_reason_check',
      sql`char_length(${t.voidReason}) <= 300`,
    ),
  ],
);

/** Dòng hóa đơn: snapshot lúc tính, `position` giữ thứ tự hiển thị. */
export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid().notNull(),
    position: integer().notNull(),
    kind: text().notNull(),
    description: text().notNull(),
    /** Có dấu: giảm trừ, miễn giảm, điều chỉnh giảm là số âm. */
    amount: bigint({ mode: 'number' }).notNull(),
    charged: boolean().notNull().default(true),
    notChargedReason: text(),
    // Không FK tới sessions: dòng là snapshot, buổi bị xóa cứng (schedule) không được chặn hay sửa dòng đã phát hành.
    sessionId: uuid(),
    sessionDate: date({ mode: 'string' }),
    className: text(),
    adjustmentReason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'invoice_lines_tenant_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('cascade'),
    unique('invoice_lines_invoice_position_uq').on(t.invoiceId, t.position),
    index('invoice_lines_session_id_idx')
      .on(t.sessionId)
      .where(sql`${t.sessionId} is not null`),
    check(
      'invoice_lines_kind_check',
      sql`${t.kind} in ('session', 'monthly', 'course_installment', 'carry_over', 'prev_adjustment', 'discount', 'surcharge', 'manual_adjustment')`,
    ),
    check(
      'invoice_lines_amount_check',
      sql`${t.amount} between -${sql.raw(MAX_VND)} and ${sql.raw(MAX_VND)}`,
    ),
    check(
      'invoice_lines_charged_amount_check',
      sql`${t.charged} or ${t.amount} = 0`,
    ),
    check(
      'invoice_lines_not_charged_reason_check',
      sql`(${t.notChargedReason} is not null) = (${t.kind} = 'session' and not ${t.charged})
        and (${t.notChargedReason} is null or ${t.notChargedReason} in ('excused_not_charged', 'unexcused_not_charged', 'cancelled', 'makeup'))`,
    ),
    check(
      'invoice_lines_adjustment_reason_check',
      sql`(${t.adjustmentReason} is not null) = (${t.kind} = 'manual_adjustment')`,
    ),
  ],
);
