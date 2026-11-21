import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { plans, tenants } from './tenancy.js';

// Feature flag theo gói, lịch sử sự kiện thuê bao, đơn chuyển khoản gói Pro (Technical Spec §4.4, US-0.7, US-0.8).
// RLS + hàm security definer ở migration 0029.

/** Danh mục feature flag theo gói (dữ liệu tham chiếu, seed ở migration): một dòng cho mỗi cặp gói × khóa. */
export const planFeatures = pgTable(
  'plan_features',
  {
    planCode: text()
      .notNull()
      .references(() => plans.code),
    featureKey: text().notNull(),
    enabled: boolean().notNull(),
  },
  (t) => [primaryKey({ columns: [t.planCode, t.featureKey] })],
);

/** Ghi đè feature flag theo tenant (quản trị đặt); không có dòng = theo gói. */
export const tenantFeatureOverrides = pgTable(
  'tenant_feature_overrides',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    featureKey: text().notNull(),
    enabled: boolean().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.featureKey] })],
);

/** Sự kiện thuê bao đã nhận (webhook RevenueCat). `event_id` duy nhất = idempotency. `payload` chỉ giữ trường kỹ thuật, không PII. */
export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    source: text().notNull(),
    eventId: text().notNull(),
    type: text().notNull(),
    outcome: text().notNull(),
    /** Thời điểm sự kiện theo nhà cung cấp, để so thứ tự giao. */
    eventAt: timestamp({ withTimezone: true }),
    payload: jsonb().notNull(),
    processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_events_event_id_uq').on(t.source, t.eventId),
    index('subscription_events_tenant_idx').on(t.tenantId, t.eventAt),
    check(
      'subscription_events_outcome_check',
      sql`${t.outcome} in ('processed', 'ignored')`,
    ),
  ],
);

/** Đơn mua Pro bằng chuyển khoản (chỉ web, R6). Một đơn `pending` mỗi tenant; quản trị xác nhận. */
export const bankTransferOrders = pgTable(
  'bank_transfer_orders',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    planCode: text()
      .notNull()
      .references(() => plans.code),
    amount: bigint({ mode: 'number' }).notNull(),
    transferNote: text().notNull(),
    payee: jsonb().notNull(),
    qrPayload: text().notNull(),
    status: text().notNull().default('pending'),
    bankTransactionRef: text(),
    confirmedBy: text(),
    confirmedAt: timestamp({ withTimezone: true }),
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'bank_transfer_orders_status_check',
      sql`${t.status} in ('pending', 'confirmed')`,
    ),
    check('bank_transfer_orders_amount_check', sql`${t.amount} > 0`),
    check(
      'bank_transfer_orders_note_check',
      sql`${t.transferNote} ~ '^[A-Z0-9 ]{1,25}$'`,
    ),
    uniqueIndex('bank_transfer_orders_pending_uq')
      .on(t.tenantId)
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex('bank_transfer_orders_note_uq').on(t.transferNote),
    index('bank_transfer_orders_status_idx').on(t.status, t.createdAt),
  ],
);
