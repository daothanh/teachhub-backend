import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '@teachhub/core';
import type { Tx } from '@teachhub/db';
import { formatInZone } from '@teachhub/modules/schedule';
import type {
  MarkReadResult,
  NotificationsQuery,
  NotificationsResponse,
} from '../http/notifications.schemas.js';

// shortcut: hiển thị giờ theo múi giờ VN, đổi sang múi giờ tenant của thông báo khi có tenant ngoài VN.
const TZ = 'Asia/Ho_Chi_Minh';

type Row = {
  id: string;
  type: string;
  urgency: 'normal' | 'urgent';
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: string;
  created_cursor: string;
};

const encode = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt}|${id}`).toString('base64url');

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Con trỏ chặt: đúng dạng `<ISO µs>|<uuid>` và mã hóa lại phải ra đúng chuỗi gốc; sai → 422. */
function decode(cursor: string | undefined): [string, string] | null {
  if (cursor === undefined) return null;
  const [at, id, extra] = Buffer.from(cursor, 'base64url')
    .toString()
    .split('|');
  const ok =
    at !== undefined &&
    id !== undefined &&
    extra === undefined &&
    CURSOR_AT.test(at) &&
    !Number.isNaN(Date.parse(at)) &&
    CURSOR_ID.test(id) &&
    encode(at, id) === cursor;
  if (!ok) {
    throw new AppException('VALIDATION_FAILED', undefined, {
      cursor: ['Con trỏ không hợp lệ'],
    });
  }
  return [at, id];
}

/**
 * Hộp thông báo của chính user, đúng vai trò đang mở (`users.last_membership_id`; chưa có thì mọi vai trò đang hoạt động).
 * RLS đã giới hạn theo `recipient_user_id`; điều kiện `recipient_user_id` ở đây là lớp thứ hai.
 */
@Injectable()
export class NotificationsService {
  private scope(userId: string) {
    return sql`n.recipient_user_id = ${userId} and n.send_after <= now() and (
      n.membership_id = (select last_membership_id from users where id = ${userId})
      or ((select last_membership_id from users where id = ${userId}) is null
          and n.membership_id in (select id from memberships where user_id = ${userId} and status = 'active')))`;
  }

  async list(
    tx: Tx,
    userId: string,
    q: NotificationsQuery,
  ): Promise<NotificationsResponse> {
    const after = decode(q.cursor);
    const rows = (
      await tx.execute<Row>(sql`
        select n.id, n.type, n.urgency, n.payload, n.read_at,
               n.created_at::text as created_at,
               to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor
        from notifications n
        where ${this.scope(userId)}
          ${after ? sql`and (n.created_at, n.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
        order by n.created_at desc, n.id desc
        limit ${q.limit + 1}`)
    ).rows;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const unread = await this.unreadCount(tx, userId);
    return {
      items: page.map((r) => ({
        id: r.id,
        type: r.type,
        urgency: r.urgency,
        payload: r.payload,
        readAt: r.read_at ? formatInZone(new Date(r.read_at), TZ) : null,
        createdAt: formatInZone(new Date(r.created_cursor), TZ),
      })) as NotificationsResponse['items'],
      nextCursor:
        rows.length > q.limit && last
          ? encode(last.created_cursor, last.id)
          : null,
      unreadCount: unread,
    };
  }

  async markRead(
    tx: Tx,
    userId: string,
    ids: string[],
  ): Promise<MarkReadResult> {
    const uniq = [...new Set(ids)];
    const res = await tx.execute(sql`
      update notifications n set read_at = now()
      where n.id = any(${`{${uniq.join(',')}}`}::uuid[]) and n.read_at is null and ${this.scope(userId)}`);
    return {
      updated: res.rowCount ?? 0,
      unreadCount: await this.unreadCount(tx, userId),
    };
  }

  private async unreadCount(tx: Tx, userId: string): Promise<number> {
    const r = await tx.execute<{ c: number }>(
      sql`select count(*)::int as c from notifications n where n.read_at is null and ${this.scope(userId)}`,
    );
    return r.rows[0]?.c ?? 0;
  }
}
