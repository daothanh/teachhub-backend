import { sql } from 'drizzle-orm';
import type { Tx } from '@teachhub/db';
import { parseQuietWindow, quietUntil } from '../domain/quiet-hours.js';

/**
 * Giờ yên lặng của tenant (US-6.5): `now` trong khung thì trả mốc hết khung (ghi vào `notifications.send_after`), ngoài khung `null`.
 * Chỉ tin không khẩn gọi hàm này; tin khẩn luôn gửi ngay.
 */
export async function quietUntilFor(
  tx: Tx,
  tenantId: string,
  now = new Date(),
): Promise<Date | null> {
  const t = (
    await tx.execute<{ timezone: string; settings: unknown }>(
      sql`select timezone, settings from tenants where id = ${tenantId}`,
    )
  ).rows[0];
  return t ? quietUntil(now, t.timezone, parseQuietWindow(t.settings)) : null;
}

/**
 * `notification_settings` của các lớp liên quan tới một hóa đơn (US-6.2): lớp của buổi trong dòng hóa đơn, cộng lớp mà học
 * viên có ghi danh và trùng tên `invoice_lines.class_name` (dòng theo tháng/khóa chỉ lưu tên lớp, không lưu id).
 * Rỗng = không xác định được lớp → coi như không bị tắt.
 * shortcut: khớp theo tên lớp; hai lớp trùng tên mà học viên cùng ghi danh cả hai thì lấy cả hai. Thêm `class_id` vào dòng hóa đơn khi cần chính xác.
 */
export async function invoiceClassSettings(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  studentId: string,
): Promise<unknown[]> {
  const r = await tx.execute<{ settings: unknown }>(sql`
    select c.notification_settings as settings from classes c
    where c.tenant_id = ${tenantId} and (
      c.id in (
        select s.class_id from invoice_lines l
        join sessions s on s.tenant_id = l.tenant_id and s.id = l.session_id
        where l.tenant_id = ${tenantId} and l.invoice_id = ${invoiceId})
      or (c.name in (
            select l.class_name from invoice_lines l
            where l.tenant_id = ${tenantId} and l.invoice_id = ${invoiceId} and l.class_name is not null)
          and exists (select 1 from enrollments e
            where e.tenant_id = ${tenantId} and e.class_id = c.id and e.student_id = ${studentId})))`);
  return r.rows.map((x) => x.settings);
}
