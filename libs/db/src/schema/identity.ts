import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { branches, tenants } from './tenancy.js';

// Danh tính (Technical Spec §4.4). RLS, audit, hàm app_private viết tay ở migration identity_rls.
// id là UUID v7 sinh ở ứng dụng (ADR-TH-BE-001 §3).

const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

/** Một người = một user, không thuộc tenant. `email` lưu chữ thường, đã xác minh. */
export const users = pgTable('users', {
  id: uuid().primaryKey(),
  email: text().unique(),
  displayName: text(),
  avatarFileId: uuid(),
  lastMembershipId: uuid().references((): AnyPgColumn => memberships.id, {
    onDelete: 'set null',
  }),
  /** `mv` trong access token; tăng khi membership đổi để vô hiệu cache (S1-BE-07b). */
  membershipsVersion: integer().notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp({ withTimezone: true }),
});

/** Cách đăng nhập: Google/Apple (`sub` của id_token) hoặc email OTP. */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    subject: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject_uq').on(
      t.provider,
      t.subject,
    ),
    index('auth_identities_user_id_idx').on(t.userId),
    check(
      'auth_identities_provider_check',
      sql`${t.provider} in ('google', 'apple', 'email')`,
    ),
  ],
);

/** Phiên đăng nhập; chỉ lưu băm SHA-256 của token (§4.8). Xoay vòng theo `family_id` (S1-BE-05). */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid().notNull(),
    familyId: uuid().notNull(),
    tokenHash: text().notNull().unique(),
    deviceInfo: jsonb(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    replacedBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index('refresh_tokens_family_id_idx').on(t.familyId),
    index('refresh_tokens_user_id_idx').on(t.userId),
  ],
);

/** Vai trò có phạm vi (FR-0.9). Vai trò nhân sự gắn tenant; phụ huynh/học sinh không gắn tenant. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().notNull(),
    tenantId: uuid().references(() => tenants.id),
    /** null = toàn tenant. */
    branchId: uuid().references(() => branches.id),
    // FK tới students thêm khi có bảng (Sprint 2).
    studentId: uuid(),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('memberships_user_role_scope_uq').on(
      t.userId,
      t.role,
      sql`coalesce(${t.tenantId}, '00000000-0000-0000-0000-000000000000')`,
      sql`coalesce(${t.studentId}, '00000000-0000-0000-0000-000000000000')`,
    ),
    index('memberships_user_id_status_idx').on(t.userId, t.status),
    index('memberships_tenant_id_idx').on(t.tenantId),
    check(
      'memberships_role_check',
      sql`${t.role} in ('tenant_owner', 'teacher', 'accountant', 'branch_manager', 'parent', 'student')`,
    ),
    check(
      'memberships_status_check',
      sql`${t.status} in ('active', 'revoked')`,
    ),
    // Nhân sự luôn có tenant; phụ huynh/học sinh thì không (§4.2).
    check(
      'memberships_scope_check',
      sql`(${t.role} in ('parent', 'student')) = (${t.tenantId} is null)
        and (${t.studentId} is null or ${t.role} = 'student')`,
    ),
  ],
);
