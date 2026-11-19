import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { guardians, students } from './students.js';
import { tenants } from './tenancy.js';
import { users } from './identity.js';

// Lời mời phụ huynh và đồng ý xử lý dữ liệu (Technical Spec §4.4). RLS, hàm security definer, trigger chặn
// sửa/xóa consents viết tay cuối file migration invites_consents.

/**
 * Lời mời phụ huynh. Chỉ lưu băm: `token_hash` = SHA-256 của token 256-bit, `short_code_hash` = HMAC-SHA256 của mã
 * 8 ký tự đã chuẩn hóa (không gian 2^40, băm trơn dò được ngoại tuyến nếu lộ bảng). `status` chỉ có pending/used/revoked;
 * "hết hạn" tính theo `expires_at` lúc đọc.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    studentId: uuid().notNull(),
    guardianId: uuid().notNull(),
    kind: text().notNull().default('parent'),
    tokenHash: text().notNull().unique(),
    shortCodeHash: text().notNull(),
    /** Mã ngắn sống 48 giờ, ngắn hơn link (`expires_at`, 7 ngày) vì dễ đoán hơn. */
    shortCodeExpiresAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default('pending'),
    usedAt: timestamp({ withTimezone: true }),
    usedBy: uuid().references(() => users.id),
    /** Tên hiển thị của người nhận lúc nhận, để giáo viên phát hiện nhận nhầm (không đọc được `users` của người khác). */
    acceptedByName: text(),
    revokedAt: timestamp({ withTimezone: true }),
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'invites_tenant_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    // Phụ huynh phải thuộc đúng học viên và tenant đó.
    foreignKey({
      name: 'invites_tenant_student_guardian_fk',
      columns: [t.tenantId, t.studentId, t.guardianId],
      foreignColumns: [guardians.tenantId, guardians.studentId, guardians.id],
    }),
    // Mã ngắn duy nhất khi còn hiệu lực; va chạm thì sinh lại.
    uniqueIndex('invites_short_code_pending_uq')
      .on(t.shortCodeHash)
      .where(sql`${t.status} = 'pending'`),
    // Mỗi phụ huynh một lời mời còn hiệu lực: tạo mới phải vô hiệu cái cũ trong cùng giao dịch.
    uniqueIndex('invites_guardian_pending_uq')
      .on(t.guardianId)
      .where(sql`${t.status} = 'pending'`),
    index('invites_tenant_student_idx').on(t.tenantId, t.studentId),
    index('invites_guardian_created_idx').on(t.guardianId, t.createdAt.desc()),
    // Tra lời mời đã dùng theo user (xóa tài khoản, tra cứu về sau): chỉ các dòng có used_by.
    index('invites_used_by_idx')
      .on(t.usedBy)
      .where(sql`${t.usedBy} is not null`),
    check('invites_kind_check', sql`${t.kind} in ('parent', 'student')`),
    check(
      'invites_status_check',
      sql`${t.status} in ('pending', 'used', 'revoked')`,
    ),
  ],
);

/**
 * Đồng ý xử lý dữ liệu theo vai trò (FR-0.14, Nghị định 13). Chỉ ghi thêm: UPDATE/DELETE/TRUNCATE bị chặn
 * bằng quyền và trigger. `ip_hash` là HMAC của IP, không lưu IP thô.
 */
export const consents = pgTable(
  'consents',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    role: text().notNull(),
    termsVersion: text().notNull(),
    acceptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ipHash: text(),
    userAgent: text(),
  },
  (t) => [
    index('consents_user_role_version_idx').on(
      t.userId,
      t.role,
      t.termsVersion,
      t.acceptedAt.desc(),
    ),
    check(
      'consents_role_check',
      sql`${t.role} in ('parent', 'student', 'tenant_owner')`,
    ),
    check(
      'consents_user_agent_length_check',
      sql`char_length(${t.userAgent}) <= 255`,
    ),
  ],
);
