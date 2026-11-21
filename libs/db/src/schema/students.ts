import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { classes } from './classes.js';
import { tenants } from './tenancy.js';
import { users } from './identity.js';

// Học viên, phụ huynh, ghi danh (Technical Spec §4.4). Hàm app_private.f_unaccent, RLS, trigger ≤ 2 phụ huynh
// viết tay trong migration students.

const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

/** Hồ sơ học viên của tenant, dùng chung cho nhiều lớp (US-1.4 AC3). */
export const students = pgTable(
  'students',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    fullName: text().notNull(),
    /** Chữ thường, bỏ dấu: phục vụ tìm kiếm và phát hiện trùng. Không ghi trực tiếp. */
    fullNameUnaccent: text().generatedAlwaysAs(
      sql`lower(app_private.f_unaccent(full_name))`,
    ),
    dob: date({ mode: 'string' }),
    school: text(),
    schoolClass: text(),
    note: text(),
    status: text().notNull().default('active'),
    statusEffectiveOn: date({ mode: 'string' }),
    /** Trigger `students_status_changed` ghi khi `status` đổi (không ghi lúc INSERT): lúc đổi và trạng thái trước đó. Billing xét trạng thái theo kỳ bằng hai cột này. */
    statusChangedAt: timestamp({ withTimezone: true }),
    statusBefore: text(),
    leftReason: text(),
    isReadonly: boolean().notNull().default(false),
    createdBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('students_tenant_id_id_uq').on(t.tenantId, t.id),
    index('students_tenant_status_idx').on(t.tenantId, t.status),
    // Không có index GIN trigram cho tìm tên: dưới RLS (teachhub_app) planner không dùng được vì `~~` không leakproof
    // (EXPLAIN, kể cả enable_seqscan = off, S2 vòng sửa). shortcut: tìm tên quét theo `tenant_id`; khi một tenant
    // vượt vài chục nghìn học viên, thêm hàm leakproof hoặc cột tìm kiếm riêng.
    check(
      'students_status_check',
      sql`${t.status} in ('active', 'paused', 'left')`,
    ),
  ],
);

/**
 * Phụ huynh của học viên, tối đa 2 dòng chưa gỡ (trigger). `deletedAt` = đã gỡ liên kết. Không bật trigger audit
 * cho bảng này: `before_data`/`after_data` sẽ chép họ tên, SĐT, email vào `audit_logs` (PII).
 */
export const guardians = pgTable(
  'guardians',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    studentId: uuid().notNull(),
    fullName: text().notNull(),
    relation: text().notNull().default('guardian'),
    phone: text(),
    email: text(),
    /** Gắn khi phụ huynh kích hoạt tài khoản (Sprint sau). */
    userId: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'guardians_tenant_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    // Đích của khóa ngoại kép (tenant_id, student_id, guardian_id) từ invites.
    unique('guardians_tenant_student_id_uq').on(t.tenantId, t.studentId, t.id),
    index('guardians_student_id_idx').on(t.studentId),
    index('guardians_user_id_idx')
      .on(t.userId)
      .where(sql`${t.userId} is not null`),
    check(
      'guardians_relation_check',
      sql`${t.relation} in ('father', 'mother', 'guardian')`,
    ),
  ],
);

/** Ghi danh lớp ↔ học viên; đổi lớp = đóng dòng cũ (`left_on`) và mở dòng mới, giữ lịch sử. */
export const enrollments = pgTable(
  'enrollments',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    classId: uuid().notNull(),
    studentId: uuid().notNull(),
    joinedOn: date({ mode: 'string' }).notNull(),
    leftOn: date({ mode: 'string' }),
    /** Mức riêng của học viên (FeeOverride); null = kế thừa lớp. */
    feeOverride: jsonb(),
    /** Nhắc nợ (S6-BE-04, US-7.5 AC3): học viên chỉ không được nhắc khi mọi ghi danh đang mở đều `false`. */
    dunningEnabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'enrollments_tenant_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    foreignKey({
      name: 'enrollments_tenant_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    // Một học viên không có hai ghi danh mở cùng lớp.
    uniqueIndex('enrollments_open_uq')
      .on(t.classId, t.studentId)
      .where(sql`${t.leftOn} is null`),
    index('enrollments_student_id_idx').on(t.studentId),
    check(
      'enrollments_fee_override_check',
      sql`${t.feeOverride} is null or (jsonb_typeof(${t.feeOverride}) = 'object' and pg_column_size(${t.feeOverride}) < 4096)`,
    ),
    check(
      'enrollments_left_on_check',
      sql`${t.leftOn} is null or ${t.leftOn} >= ${t.joinedOn}`,
    ),
  ],
);
