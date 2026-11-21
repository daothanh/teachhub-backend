import { sql } from 'drizzle-orm';
import type { Tx } from './tx.service.js';

/** Ghi một dòng `audit_logs` qua hàm security definer (role app không insert trực tiếp). Actor lấy từ `app.user_id` của giao dịch. */
export async function writeAudit(
  tx: Tx,
  a: {
    tenantId: string;
    entity: string;
    entityId: string;
    action: 'insert' | 'update' | 'delete';
    before: object | null;
    after: object | null;
  },
): Promise<void> {
  await tx.execute(
    sql`select app_private.audit_insert(${a.tenantId}::uuid, ${a.entity}, ${a.entityId}::uuid, ${a.action},
      ${a.before === null ? null : JSON.stringify(a.before)}::jsonb, ${a.after === null ? null : JSON.stringify(a.after)}::jsonb)`,
  );
}
