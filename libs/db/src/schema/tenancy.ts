import {
  boolean,
  check,
  index,
  unique,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Tenant, chi nhánh, gói (Technical Spec §4.4). RLS, seed `plans` ở migration tenancy_rls.

/** Đơn vị cách ly và tính phí. Tạo cùng chi nhánh mặc định + chủ tenant trong POST /workspaces (S1-BE-08). */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey(),
    type: text().notNull(),
    name: text().notNull(),
    timezone: text().notNull().default('Asia/Ho_Chi_Minh'),
    businessRegNo: text(),
    teachesAtSchool: boolean().notNull().default(false),
    /** Giờ yên lặng, ngày chốt, hạn thanh toán, lịch nhắc nợ, ngưỡng cảnh báo vắng. */
    settings: jsonb().notNull().default({}),
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check(
      'tenants_type_check',
      sql`${t.type} in ('teacher', 'center', 'chain')`,
    ),
  ],
);

/** MVP: mỗi tenant một chi nhánh mặc định. */
export const branches = pgTable(
  'branches',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    name: text().notNull(),
    address: text(),
    isDefault: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('branches_tenant_default_uq')
      .on(t.tenantId)
      .where(sql`${t.isDefault}`),
    index('branches_tenant_id_idx').on(t.tenantId),
    // Đích của FK (tenant_id, branch_id): bảng con không trỏ được chi nhánh của tenant khác.
    unique('branches_tenant_id_id_uq').on(t.tenantId, t.id),
  ],
);

/** Định nghĩa gói. `limits`: giá trị null = không giới hạn (US-0.7). */
export const plans = pgTable('plans', {
  code: text().primaryKey(),
  limits: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Gói hiện tại của tenant (một dòng/tenant). Chỉ worker/hàm đặc quyền đổi gói. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .unique()
      .references(() => tenants.id),
    planCode: text()
      .notNull()
      .references(() => plans.code),
    status: text().notNull().default('free'),
    trialUsedAt: timestamp({ withTimezone: true }),
    currentPeriodEnd: timestamp({ withTimezone: true }),
    source: text(),
    externalRef: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'subscriptions_status_check',
      sql`${t.status} in ('free', 'trialing', 'active', 'expired')`,
    ),
    check(
      'subscriptions_source_check',
      sql`${t.source} is null or ${t.source} in ('app_store', 'play_store', 'bank_transfer')`,
    ),
  ],
);
