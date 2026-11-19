import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { classes } from './classes.js';
import { tenants } from './tenancy.js';

// Lịch lặp và buổi học (Technical Spec §4.4). RLS, trigger updated_at viết tay cuối file migration schedule.
// Chưa có valid_from/valid_to (bộ quy tắc thay nguyên khối), makeup_of, cancel_reason, holiday_ack: thêm cùng US-2.2, US-2.6.

const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

/** Quy tắc lặp hằng tuần của lớp; `weekday` theo ISO (1 = Thứ Hai … 7 = Chủ Nhật), `start_time` theo múi giờ tenant. */
export const scheduleRules = pgTable(
  'schedule_rules',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    classId: uuid().notNull(),
    weekday: integer().notNull(),
    startTime: time().notNull(),
    durationMin: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'schedule_rules_tenant_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    unique('schedule_rules_class_weekday_start_uq').on(
      t.classId,
      t.weekday,
      t.startTime,
    ),
    check('schedule_rules_weekday_check', sql`${t.weekday} between 1 and 7`),
    check(
      'schedule_rules_duration_check',
      sql`${t.durationMin} between 15 and 480`,
    ),
    check(
      'schedule_rules_within_day_check',
      sql`extract(epoch from ${t.startTime}) / 60 + ${t.durationMin} <= 1440`,
    ),
  ],
);

/** Buổi học cụ thể, đơn vị tính học phí. Sinh từ quy tắc; (rule_id, session_date) duy nhất để sinh lại không trùng. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    classId: uuid().notNull(),
    /** null = buổi bù/lẻ không từ quy tắc, hoặc quy tắc đã bị thay (buổi đã dạy giữ nguyên). */
    ruleId: uuid().references(() => scheduleRules.id, { onDelete: 'set null' }),
    /** Ngày học theo múi giờ tenant. */
    // Ngày theo múi giờ tenant tại lúc sinh buổi; đổi múi giờ tenant về sau không dịch lại các buổi đã sinh.
    sessionDate: date({ mode: 'string' }).notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default('planned'),
    isMakeup: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'sessions_tenant_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    unique('sessions_rule_date_uq').on(t.ruleId, t.sessionDate),
    // Đích của khóa ngoại kép (tenant_id, session_id) từ attendance.
    // shortcut: unique thêm trên bảng sessions khóa bảng khi tạo; chấp nhận vì bảng còn nhỏ, bảng lớn thì tạo index CONCURRENTLY rồi gắn constraint.
    unique('sessions_tenant_id_id_uq').on(t.tenantId, t.id),
    index('sessions_tenant_date_idx').on(t.tenantId, t.sessionDate, t.startsAt),
    index('sessions_class_date_idx').on(t.classId, t.sessionDate),
    check(
      'sessions_status_check',
      sql`${t.status} in ('planned', 'taught', 'cancelled')`,
    ),
    check('sessions_time_check', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
