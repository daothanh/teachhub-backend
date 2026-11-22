import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './identity.js';
import { tenants } from './tenancy.js';

// Metadata tệp trên kho S3 (Technical Spec §3.6c, §4.4; S8-BE-files). Tệp không đi qua API: client PUT/GET qua presigned URL.
// RLS + FORCE, policy theo người tải lên/nhân sự tenant viết tay cuối migration 0035. `tenant_id` lấy từ thực thể (hóa đơn), không từ client.

/** Giới hạn theo `purpose` (Spec §3.3): mục đích mới thêm vào đây cùng CHECK `files_purpose_check`. */
export const files = pgTable(
  'files',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    /** Người xin URL = người duy nhất `complete` và (với biên lai) tải lại ở phía phụ huynh. */
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    purpose: text().notNull(),
    /** Thực thể tệp gắn vào (`receipt` → id hóa đơn); không FK vì phụ thuộc `purpose`, kiểm quyền ở hàm/service. */
    entityId: uuid().notNull(),
    bucket: text().notNull(),
    /** `{tenant_id}/{prefix}/{entity_id}/{uuid v4}.{ext}`: UUID ngẫu nhiên nên không đoán được; tên gốc không nằm trong khóa. */
    objectKey: text().notNull(),
    originalName: text().notNull(),
    mime: text().notNull(),
    /** Kích thước khai báo; sau `complete` đã khớp HEAD kho S3. */
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    status: text().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('files_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('files_object_key_uq').on(t.bucket, t.objectKey),
    index('files_entity_idx').on(t.tenantId, t.purpose, t.entityId),
    index('files_owner_idx').on(t.ownerUserId),
    // Job dọn tệp `pending` quá 24 giờ.
    index('files_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check('files_purpose_check', sql`${t.purpose} in ('receipt')`),
    check('files_status_check', sql`${t.status} in ('pending', 'ready')`),
    check(
      'files_ready_check',
      sql`(${t.status} = 'ready') = (${t.readyAt} is not null)`,
    ),
    check('files_size_check', sql`${t.sizeBytes} between 1 and 20000000`),
    check(
      'files_name_check',
      sql`char_length(${t.originalName}) between 1 and 255`,
    ),
  ],
);
