import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface SeededTenant {
  userId: string;
  tenantId: string;
  branchId: string;
}

/** Dựng một giáo viên + tenant + chi nhánh mặc định + membership `tenant_owner` bằng teachhub_worker (BYPASSRLS). */
export async function seedTenant(
  worker: pg.Pool,
  /** Mặc định `pro`: các e2e khác tạo nhiều lớp/học sinh hơn giới hạn Free (US-0.7); test gói truyền `free`. */
  plan: 'free' | 'pro' = 'pro',
): Promise<SeededTenant> {
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
  await worker.query(
    `insert into subscriptions (id, tenant_id, plan_code, status, current_period_end)
     values ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      s.tenantId,
      plan,
      plan === 'pro' ? 'active' : 'free',
      plan === 'pro' ? '2099-01-01T00:00:00Z' : null,
    ],
  );
  return s;
}

/** User có membership `role` ở tenant (vd. `teacher`): không phải `tenant_owner` nên bị guard chặn 403. */
export async function seedMember(
  worker: pg.Pool,
  tenantId: string,
  role: 'teacher' | 'accountant' | 'branch_manager',
): Promise<string> {
  const userId = randomUUID();
  await worker.query(`insert into users (id, email) values ($1, $2)`, [
    userId,
    `${userId}@example.com`,
  ]);
  await worker.query(
    `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, $3, $4)`,
    [randomUUID(), userId, role, tenantId],
  );
  return userId;
}
