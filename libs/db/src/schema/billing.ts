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
import { users } from './identity.js';
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
    /** Σ thanh toán chưa hủy (S6-BE-02), cập nhật cùng giao dịch ghi/hủy thanh toán dưới `FOR UPDATE`; có thể > total_amount khi trả thừa. */
    paidAmount: bigint({ mode: 'number' }).notNull().default(0),
    /** Phần còn nợ đã chuyển sang hóa đơn kỳ sau (S6-BE-03) = Σ(debit − credit) `unpaid_carried` của hóa đơn trong sổ (constraint trigger); không còn tính vào công nợ ở đây. */
    carriedAmount: bigint({ mode: 'number' }).notNull().default(0),
    /** Hạn cũ nhất của các khoản nợ được chuyển vào hóa đơn này lúc phát hành (tuổi nợ T11); null = không có kết chuyển. */
    oldestDueDate: date({ mode: 'string' }),
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
    check(
      'invoices_paid_amount_check',
      sql`${t.paidAmount} >= 0 and ${t.paidAmount} <= ${sql.raw(MAX_VND)}`,
    ),
    check(
      'invoices_carried_amount_check',
      sql`${t.carriedAmount} >= 0 and ${t.carriedAmount} <= ${t.totalAmount}
        and (${t.carriedAmount} = 0 or ${t.paidAmount} + ${t.carriedAmount} <= ${t.totalAmount})
        and (${t.status} <> 'draft' or ${t.carriedAmount} = 0)`,
    ),
    // Công nợ T11: chỉ quét hóa đơn còn mở của học viên.
    index('invoices_debt_idx')
      .on(t.tenantId, t.studentId)
      .where(sql`${t.status} in ('issued', 'partially_paid', 'pending_confirmation')`),
    // Trạng thái khớp số đã thu; `pending_confirmation` (US-7.7, chưa làm) chưa thu đủ. paid_amount = Σ payments chưa hủy do constraint trigger.
    check(
      'invoices_paid_status_check',
      sql`case ${t.status}
        when 'partially_paid' then ${t.paidAmount} > 0 and ${t.paidAmount} < ${t.totalAmount}
        when 'paid' then ${t.paidAmount} >= ${t.totalAmount}
        when 'pending_confirmation' then ${t.paidAmount} < ${t.totalAmount}
        else ${t.paidAmount} = 0 end`,
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
    // Bản nháp chưa có gì của phát hành; từ `issued` trở đi phải đủ mã, nội dung chuyển khoản, QR, snapshot, giờ phát hành (hóa đơn 0 đ đã trả bằng số dư, S6-BE-03, không có QR).
    check(
      'invoices_issue_fields_check',
      sql`case when ${t.status} = 'draft'
        then ${t.code} is null and ${t.transferNote} is null and ${t.qrPayload} is null and ${t.payout} is null and ${t.issuedAt} is null
        else ${t.code} is not null and ${t.transferNote} is not null and (${t.qrPayload} is not null or ${t.totalAmount} = 0) and ${t.payout} is not null and ${t.issuedAt} is not null end`,
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

const methods = `'bank_transfer', 'cash'`;

/**
 * Một lần thu tiền của hóa đơn (US-7.4). Không xóa: hủy = đặt `voided_*` một lần (trigger payments_guard), kèm bút toán đảo ở
 * hai sổ. `recorded_by`/`voided_by` là user của tenant (tên đọc qua app_private.tenant_user_names).
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid().notNull(),
    amount: bigint({ mode: 'number' }).notNull(),
    method: text().notNull(),
    paidOn: date({ mode: 'string' }).notNull(),
    note: text(),
    recordedBy: uuid()
      .notNull()
      .references(() => users.id),
    /** Ảnh chụp tên hiển thị lúc ghi/hủy: không phụ thuộc membership hay tài khoản còn hay không. */
    recordedByName: text().notNull(),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp({ withTimezone: true }),
    voidReason: text(),
    voidedBy: uuid().references(() => users.id),
    voidedByName: text(),
  },
  (t) => [
    foreignKey({
      name: 'payments_tenant_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    unique('payments_tenant_id_id_uq').on(t.tenantId, t.id),
    index('payments_tenant_paid_on_idx').on(t.tenantId, t.paidOn),
    index('payments_invoice_idx').on(
      t.tenantId,
      t.invoiceId,
      t.recordedAt.desc(),
      t.id.desc(),
    ),
    index('payments_recorded_by_idx').on(t.recordedBy),
    index('payments_voided_by_idx')
      .on(t.voidedBy)
      .where(sql`${t.voidedBy} is not null`),
    check(
      'payments_amount_check',
      sql`${t.amount} > 0 and ${t.amount} <= ${sql.raw(MAX_VND)}`,
    ),
    check('payments_method_check', sql`${t.method} in (${sql.raw(methods)})`),
    check('payments_note_check', sql`char_length(${t.note}) <= 300`),
    check(
      'payments_void_fields_check',
      sql`(${t.voidedAt} is null) = (${t.voidReason} is null) and (${t.voidedAt} is null) = (${t.voidedBy} is null)
        and (${t.voidedAt} is null) = (${t.voidedByName} is null)
        and (${t.voidReason} is null or char_length(${t.voidReason}) between 1 and 300)`,
    ),
  ],
);

/**
 * Sổ cái công nợ học viên, chỉ ghi thêm (trigger chặn UPDATE/DELETE/TRUNCATE). Số dư = Σ(debit − credit): dương = nợ cũ,
 * âm = trả thừa chờ trừ kỳ sau. S6-BE-02 ghi `overpayment` (credit) và `payment_void` (debit); các loại còn lại do S6-BE-03.
 */
export const studentLedger = pgTable(
  'student_ledger',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    studentId: uuid().notNull(),
    invoiceId: uuid(),
    paymentId: uuid(),
    kind: text().notNull(),
    debit: bigint({ mode: 'number' }).notNull().default(0),
    credit: bigint({ mode: 'number' }).notNull().default(0),
    description: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'student_ledger_tenant_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'student_ledger_tenant_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: 'student_ledger_tenant_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    index('student_ledger_student_idx').on(
      t.tenantId,
      t.studentId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('student_ledger_invoice_idx')
      .on(t.tenantId, t.invoiceId)
      .where(sql`${t.invoiceId} is not null`),
    index('student_ledger_payment_idx')
      .on(t.tenantId, t.paymentId)
      .where(sql`${t.paymentId} is not null`),
    check(
      'student_ledger_kind_check',
      sql`${t.kind} in ('unpaid_carried', 'overpayment', 'prev_adjustment', 'applied_to_invoice', 'payment_void')`,
    ),
    // Mỗi dòng đúng một vế khác 0.
    check(
      'student_ledger_amount_check',
      sql`${t.debit} between 0 and ${sql.raw(MAX_VND)} and ${t.credit} between 0 and ${sql.raw(MAX_VND)} and (${t.debit} > 0) <> (${t.credit} > 0)`,
    ),
  ],
);

/**
 * Sổ doanh thu (US-9.5 AC1), chỉ ghi thêm. `amount` có dấu: dòng thu > 0, dòng đảo khi hủy < 0 và mang `entry_date`,
 * `fiscal_year` của dòng thu gốc (hủy thanh toán là sửa sai, doanh thu của năm đó không còn khoản này).
 */
export const revenueLedger = pgTable(
  'revenue_ledger',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid().notNull(),
    kind: text().notNull(),
    amount: bigint({ mode: 'number' }).notNull(),
    entryDate: date({ mode: 'string' }).notNull(),
    fiscalYear: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'revenue_ledger_tenant_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    // Mỗi thanh toán tối đa một dòng thu và một dòng đảo.
    unique('revenue_ledger_payment_kind_uq').on(t.paymentId, t.kind),
    index('revenue_ledger_year_idx').on(t.tenantId, t.fiscalYear, t.entryDate),
    check(
      'revenue_ledger_kind_check',
      sql`${t.kind} in ('payment', 'reversal')`,
    ),
    check(
      'revenue_ledger_amount_check',
      sql`case ${t.kind} when 'payment' then ${t.amount} between 1 and ${sql.raw(MAX_VND)} else ${t.amount} between -${sql.raw(MAX_VND)} and -1 end`,
    ),
    check(
      'revenue_ledger_year_check',
      sql`${t.fiscalYear} = extract(year from ${t.entryDate})::int`,
    ),
  ],
);
