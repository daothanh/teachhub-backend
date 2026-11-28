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
import { users } from './identity.js';
import { sessions } from './schedule.js';
import { students } from './students.js';
import { tenants } from './tenancy.js';

// Phụ huynh báo vắng trước (Technical Spec §4.4 `absence_requests`, US-3.4). RLS, FORCE và hàm security definer viết tay
// cuối migration: phụ huynh không có quyền ghi bảng, chỉ đọc báo vắng của con đã liên kết.

/**
 * Một báo vắng của một con cho một buổi. "Đang hiệu lực" = `cancelled_at is null`; hủy chỉ đặt `cancelled_at` (không xóa)
 * nên báo lại sau khi hủy tạo dòng mới, còn tối đa MỘT dòng hiệu lực cho (buổi, con).
 */
export const absenceRequests = pgTable(
  'absence_requests',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    sessionId: uuid().notNull(),
    studentId: uuid().notNull(),
    reportedByUserId: uuid()
      .notNull()
      .references(() => users.id),
    reason: text().notNull(),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'absence_requests_tenant_session_fk',
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [sessions.tenantId, sessions.id],
    }),
    foreignKey({
      name: 'absence_requests_tenant_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    // Một báo vắng hiệu lực mỗi (buổi, con); cũng là chỉ mục đọc theo buổi cho màn điểm danh.
    uniqueIndex('absence_requests_active_uq')
      .on(t.sessionId, t.studentId)
      .where(sql`${t.cancelledAt} is null`),
    index('absence_requests_student_idx')
      .on(t.studentId)
      .where(sql`${t.cancelledAt} is null`),
    index('absence_requests_reported_by_idx').on(t.reportedByUserId),
    check(
      'absence_requests_reason_check',
      sql`${t.reason} in ('sick', 'family', 'other')`,
    ),
    check('absence_requests_note_check', sql`char_length(${t.note}) <= 300`),
    check(
      'absence_requests_cancelled_check',
      sql`${t.cancelledAt} is null or ${t.cancelledAt} >= ${t.createdAt}`,
    ),
  ],
);
