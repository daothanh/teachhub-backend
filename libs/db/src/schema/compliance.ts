import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  date,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './identity.js';
import { payments } from './billing.js';
import { tenants } from './tenancy.js';

// Tuân thủ E9 (Technical Spec §4.4; S8 compliance): checklist, cảnh báo ngưỡng thuế, nhật ký xác nhận, thư viện quy định.
// Chưa có `school_declarations`, `public_disclosures` (Mẫu 02/03 chờ luật sư chốt cột). RLS, FORCE và policy viết tay ở migration.

const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

/** Checklist tuân thủ: một dòng cho mỗi (tenant, mục); chưa có dòng = `todo`. */
export const complianceItems = pgTable(
  'compliance_items',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    itemKey: text().notNull(),
    status: text().notNull(),
    data: jsonb(),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    unique('compliance_items_tenant_key_uq').on(t.tenantId, t.itemKey),
    check(
      'compliance_items_key_check',
      sql`${t.itemKey} in ('business_registration', 'registration_number', 'public_disclosure', 'school_declaration')`,
    ),
    check(
      'compliance_items_status_check',
      sql`${t.status} in ('todo', 'done', 'not_applicable')`,
    ),
    check(
      'compliance_items_completed_check',
      sql`(${t.status} = 'done') = (${t.completedAt} is not null)`,
    ),
  ],
);

/** Cảnh báo 80% ngưỡng thuế: một dòng cho mỗi (tenant, năm, mốc), không xóa, không sinh lại. */
export const taxThresholdAlerts = pgTable(
  'tax_threshold_alerts',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    fiscalYear: integer().notNull(),
    milestone: text().notNull(),
    /** Thanh toán làm lũy kế (theo thứ tự ghi sổ) chạm mốc lần đầu. */
    paymentId: uuid(),
    cumulativeAmount: bigint({ mode: 'number' }).notNull(),
    triggeredAt: timestamp({ withTimezone: true }).notNull(),
    dismissedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('tax_threshold_alerts_tenant_year_milestone_uq').on(
      t.tenantId,
      t.fiscalYear,
      t.milestone,
    ),
    foreignKey({
      name: 'tax_threshold_alerts_tenant_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    check(
      'tax_threshold_alerts_milestone_check',
      sql`${t.milestone} in ('400m', '800m')`,
    ),
    check(
      'tax_threshold_alerts_year_check',
      sql`${t.fiscalYear} between 2020 and 2100`,
    ),
  ],
);

/** Nhật ký "Tôi đã hiểu, vẫn tạo" (US-9.3 AC3). Chỉ ghi thêm. */
export const acknowledgements = pgTable(
  'acknowledgements',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    kind: text().notNull(),
    entityId: uuid().notNull(),
    /** Mã cảnh báo đã xác nhận (vd. `TT29_PRIMARY_ACADEMIC`); cột bổ sung ngoài bảng Spec để mỗi mã một dòng. */
    code: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('acknowledgements_entity_code_uq').on(
      t.tenantId,
      t.kind,
      t.entityId,
      t.code,
    ),
    check('acknowledgements_kind_check', sql`${t.kind} in ('class_warning')`),
  ],
);

/** Thư viện quy định (toàn hệ thống, không có `tenant_id`). Chỉ bài `published` có người duyệt mới lộ ra app. */
export const legalArticles = pgTable(
  'legal_articles',
  {
    id: uuid().primaryKey(),
    slug: text().notNull().unique('legal_articles_slug_uq'),
    title: text().notNull(),
    summary: text().notNull(),
    bodyMarkdown: text().notNull(),
    sources: jsonb().notNull(),
    version: integer().notNull().default(1),
    status: text().notNull().default('draft'),
    reviewedBy: text(),
    reviewerRole: text(),
    reviewedOn: date({ mode: 'string' }),
    publishedBy: text(),
    publishedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    index('legal_articles_published_idx').on(t.publishedAt),
    check(
      'legal_articles_status_check',
      sql`${t.status} in ('draft', 'published')`,
    ),
    check(
      'legal_articles_reviewer_role_check',
      sql`${t.reviewerRole} is null or ${t.reviewerRole} in ('lawyer', 'accountant')`,
    ),
    // Bài đã phát hành phải có người duyệt (US-9.6 AC3).
    check(
      'legal_articles_published_check',
      sql`${t.status} <> 'published' or (${t.reviewedBy} is not null and ${t.reviewerRole} is not null and ${t.reviewedOn} is not null and ${t.publishedAt} is not null)`,
    ),
  ],
);
