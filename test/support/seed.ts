import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface SeededTenant {
  userId: string;
  tenantId: string;
  branchId: string;
}

/** Dựng một giáo viên + tenant + chi nhánh mặc định + membership `tenant_owner` bằng teachhub_worker (BYPASSRLS). */
export async function seedTenant(worker: pg.Pool): Promise<SeededTenant> {
  const s = {
    userId: randomUUID(),
    tenantId: randomUUID(),
    branchId: randomUUID(),
  };
  await worker.query(`insert into users (id, email) values ($1, $2)`, [
    s.userId,
    `${s.userId}@example.com`,
  ]);
  await worker.query(
    `insert into tenants (id, type, name) values ($1, 'teacher', 'Lớp thử')`,
    [s.tenantId],
  );
  await worker.query(
    `insert into branches (id, tenant_id, name, is_default) values ($1, $2, 'Chính', true)`,
    [s.branchId, s.tenantId],
  );
  await worker.query(
    `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, 'tenant_owner', $3)`,
    [randomUUID(), s.userId, s.tenantId],
  );
  return s;
}
