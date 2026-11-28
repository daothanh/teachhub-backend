import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { memberships, users } from './identity.js';
import { tenants } from './tenancy.js';

// Thông báo và thiết bị push (Technical Spec §4.4). RLS, hàm đăng ký thiết bị, quyền cột viết tay cuối migration.

const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

/** Mẫu nội dung theo loại + kênh (dùng chung mọi tenant, chỉ migration ghi). */
export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: uuid().primaryKey(),
    type: text().notNull(),
    channel: text().notNull(),
    titleTpl: text().notNull(),
    bodyTpl: text().notNull(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique('notification_templates_type_channel_version_uq').on(
      t.type,
      t.channel,
      t.version,
    ),
    check(
      'notification_templates_channel_check',
      sql`${t.channel} in ('push', 'web_push', 'email', 'in_app')`,
    ),
  ],
);

/**
 * Hộp thông báo của từng người nhận. Worker ghi; api chỉ đọc và đánh dấu đã đọc dòng của chính user (RLS theo
 * `recipient_user_id`). `payload` giữ tên con/lớp cho màn hộp thư, KHÔNG bao giờ đưa vào payload FCM.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    recipientUserId: uuid()
      .notNull()
      .references(() => users.id),
    /** Vai trò của người nhận lúc phát sinh; GET /notifications lọc theo vai trò đang mở. */
    membershipId: uuid().references(() => memberships.id),
    type: text().notNull(),
    urgency: text().notNull().default('normal'),
    payload: jsonb().notNull(),
    /** Khóa chống gửi trùng khi sự kiện outbox được xử lý lại. */
    dedupeKey: text().notNull(),
    /** Giờ yên lặng: tin không khẩn dời tới đây; tin khẩn = lúc tạo. */
    sendAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Giờ server ghi sự kiện gốc (`recordedAt` của outbox); đính chính tính cửa sổ 10 phút từ mốc này. */
    eventAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('notifications_recipient_dedupe_uq').on(
      t.recipientUserId,
      t.dedupeKey,
    ),
    index('notifications_recipient_created_idx').on(
      t.recipientUserId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('notifications_recipient_unread_idx')
      .on(t.recipientUserId, t.membershipId)
      .where(sql`${t.readAt} is null`),
    // Tra báo vắng của (buổi, học viên) khi đính chính, không quét cả bảng.
    index('notifications_absence_lookup_idx')
      .on(
        t.tenantId,
        sql`(${t.payload} ->> 'sessionId')`,
        sql`(${t.payload} ->> 'studentId')`,
      )
      .where(sql`${t.type} = 'student_absent'`),
    // Job `notify.deferred-push` (US-6.5) chỉ quét tin từng bị hoãn: index nhỏ, không quét cả bảng.
    index('notifications_deferred_idx')
      .on(t.sendAfter)
      .where(sql`${t.sendAfter} > ${t.createdAt}`),
    check(
      'notifications_urgency_check',
      sql`${t.urgency} in ('urgent', 'normal')`,
    ),
  ],
);

/** Trạng thái gửi của một thông báo theo kênh (US-6.1 AC4); (thông báo, kênh) duy nhất để worker không gửi trùng. */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid().primaryKey(),
    notificationId: uuid().notNull(),
    channel: text().notNull(),
    status: text().notNull().default('queued'),
    providerMessageId: text(),
    error: text(),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'notification_deliveries_notification_fk',
      columns: [t.notificationId],
      foreignColumns: [notifications.id],
    }).onDelete('cascade'),
    uniqueIndex('notification_deliveries_notification_channel_uq').on(
      t.notificationId,
      t.channel,
    ),
    check(
      'notification_deliveries_channel_check',
      sql`${t.channel} in ('push', 'web_push', 'email', 'in_app')`,
    ),
    check(
      'notification_deliveries_status_check',
      sql`${t.status} in ('queued', 'sent', 'failed')`,
    ),
  ],
);

/** Token FCM của thiết bị; một token chỉ gắn một user (đăng ký lại ở máy đổi người dùng thì chuyển chủ). */
export const devices = pgTable(
  'devices',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text().notNull(),
    token: text().notNull().unique(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('devices_user_id_idx').on(t.userId),
    index('devices_last_seen_idx').on(t.lastSeenAt),
    check(
      'devices_platform_check',
      sql`${t.platform} in ('android', 'ios', 'web')`,
    ),
    check('devices_token_length_check', sql`char_length(${t.token}) <= 4096`),
  ],
);
