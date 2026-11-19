import {
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

// Bảng hạ tầng (Mục 4.4). RLS, audit_logs (phân vùng) viết tay ở migration 0002_infra_rls_audit.
// id là UUID v7 sinh ở ứng dụng (ADR-TH-BE-001 §3), không default ở CSDL.

/** Kết quả lệnh theo `Idempotency-Key` (Mục 5.1); phạm vi khóa = (user, method + route template). */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid().primaryKey(),
    userId: uuid().notNull(),
    endpoint: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    statusCode: integer().notNull(),
    responseBody: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_user_endpoint_key_uq').on(
      t.userId,
      t.endpoint,
      t.key,
    ),
    index('idempotency_keys_created_at_idx').on(t.createdAt),
  ],
);

/** Nhật ký job nền của worker. */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid().primaryKey(),
    job: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    status: text().notNull(),
    rowsAffected: integer(),
    error: text(),
  },
  (t) => [
    check(
      'job_runs_status_check',
      sql`${t.status} in ('running', 'succeeded', 'failed')`,
    ),
    index('job_runs_job_started_at_idx').on(t.job, t.startedAt.desc()),
  ],
);

/**
 * Outbox sự kiện nghiệp vụ (Mục 3.6): ghi cùng giao dịch với lệnh, worker relay đẩy sang BullMQ.
 * `attempts`/`next_attempt_at`/`last_error`/`failed_at` phục vụ retry có backoff; quá số lần thì `failed_at` đặt và relay bỏ qua.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid().primaryKey(),
    tenantId: uuid().notNull(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastError: text(),
    failedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.dispatchedAt} is null and ${t.failedAt} is null`),
    // Phục vụ job dọn sự kiện đã gửi quá hạn giữ.
    index('outbox_events_dispatched_idx')
      .on(t.dispatchedAt)
      .where(sql`${t.dispatchedAt} is not null`),
  ],
);
