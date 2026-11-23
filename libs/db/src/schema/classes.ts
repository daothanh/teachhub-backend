import {
  bigint,
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
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { branches, tenants } from './tenancy.js';

// Lớp (Technical Spec §4.4). RLS của các bảng Sprint 2 cho mọi vai trò nhân sự của tenant (`staff_tenant_ids()`);
// quyền theo vai trò (hiện chỉ `tenant_owner`) nằm ở guard, không ở RLS. RLS, trigger updated_at/audit viết tay cuối file migration classes.
// Học phí (S5-BE-01): fee_type + fee_amount cùng có hoặc cùng null; fee_rules null = mặc định của calculator.
// Chưa có subject_kind, notification_settings: thêm cột tùy chọn ở sprint sau (US-1.2, US-9.3).

export const classes = pgTable(
  'classes',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    branchId: uuid().notNull(),
    name: text().notNull(),
    subject: text().notNull(),
    grade: integer().notNull(),
    mode: text().notNull(),
    location: text(),
    capacity: integer(),
    startDate: date({ mode: 'string' }).notNull(),
    endDate: date({ mode: 'string' }),
    status: text().notNull().default('active'),
    feeType: text(),
    feeAmount: bigint({ mode: 'number' }),
    feeRules: jsonb(),
    archivedAt: timestamp({ withTimezone: true }),
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'classes_tenant_branch_fk',
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    // Đích của FK (tenant_id, class_id) ở bảng con: bản ghi con không trỏ được lớp của tenant khác.
    unique('classes_tenant_id_id_uq').on(t.tenantId, t.id),
    index('classes_tenant_status_idx').on(t.tenantId, t.status),
    check('classes_grade_check', sql`${t.grade} between 1 and 12`),
    check('classes_mode_check', sql`${t.mode} in ('offline', 'online')`),
    check('classes_status_check', sql`${t.status} in ('active', 'archived')`),
    check(
      'classes_fee_type_check',
      sql`${t.feeType} in ('per_session', 'monthly', 'course')`,
    ),
    check(
      'classes_fee_amount_check',
      sql`${t.feeAmount} > 0 and ${t.feeAmount} <= 100000000000`,
    ),
    check(
      'classes_fee_pair_check',
      sql`(${t.feeType} is null) = (${t.feeAmount} is null)`,
    ),
    check(
      'classes_fee_rules_check',
      sql`${t.feeRules} is null or (${t.feeType} is not null and jsonb_typeof(${t.feeRules}) = 'object' and pg_column_size(${t.feeRules}) < 4096)`,
    ),
    check(
      'classes_capacity_check',
      sql`${t.capacity} is null or ${t.capacity} > 0`,
    ),
    check(
      'classes_end_date_check',
      sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);
