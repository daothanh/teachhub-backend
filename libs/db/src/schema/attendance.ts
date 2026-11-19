import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sessions } from './schedule.js';
import { students } from './students.js';
import { tenants } from './tenancy.js';

// Điểm danh (Technical Spec §4.4). RLS, trigger updated_at và trigger audit (nguồn nhật ký sửa) viết tay cuối migration.

/**
 * Một dòng cho mỗi (buổi, học viên); chưa điểm danh = không có dòng. `client_updated_at` là mốc LWW đã hiệu chỉnh
 * lệch đồng hồ thiết bị (giờ máy chủ), không phải giờ thô của thiết bị. `client_mutation_id` chỉ lưu mutation
 * thắng gần nhất của dòng; null với dòng "Có mặt" server tạo ngầm khi chuyển buổi sang đã dạy.
 */
export const attendance = pgTable(
  'attendance',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    sessionId: uuid().notNull(),
    studentId: uuid().notNull(),
    status: text().notNull(),
    note: text(),
    recordedBy: uuid(),
    clientMutationId: uuid(),
    clientUpdatedAt: timestamp({ withTimezone: true }).notNull(),
    syncedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'attendance_tenant_session_fk',
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [sessions.tenantId, sessions.id],
    }),
    foreignKey({
      name: 'attendance_tenant_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    unique('attendance_session_student_uq').on(t.sessionId, t.studentId),
    unique('attendance_tenant_mutation_uq').on(t.tenantId, t.clientMutationId),
    index('attendance_tenant_student_session_idx').on(
      t.tenantId,
      t.studentId,
      t.sessionId,
    ),
    check(
      'attendance_status_check',
      sql`${t.status} in ('present', 'late', 'excused', 'unexcused')`,
    ),
  ],
);
