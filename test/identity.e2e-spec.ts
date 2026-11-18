import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';
import {
  expectInsertRejected,
  expectRowIsolated,
  makeActors,
} from './support/isolation.js';

// S1-BE-01: bảng danh tính (migration 0003, 0004). User A không đọc/ghi được dữ liệu danh tính của B,
// kể cả truy vấn trực tiếp với app.user_id của A.
describe('danh tính: users, auth_identities, refresh_tokens, memberships', () => {
  let db: TestDb;
  let appPool: pg.Pool;
  let worker: pg.Pool;
  let tx: TxService;
  const { A, B } = makeActors();
  const ids = {
    identityA: randomUUID(),
    tokenA: randomUUID(),
    ownerA: randomUUID(),
    parentA: randomUUID(),
    revokedA: randomUUID(),
    ownerB: randomUUID(),
  };

  /** Người dùng tự tạo dữ liệu của mình — đúng đường ghi của API (RLS `with check`). */
  const seed = (userId: string, tenantId: string, ownerId: string) =>
    tx.run({ userId }, async (t) => {
      await t.execute(
        sql`insert into users (id, email) values (${userId}, ${`${userId}@test.vn`})`,
      );
      await t.execute(
        sql`insert into memberships (id, user_id, role, tenant_id) values (${ownerId}, ${userId}, 'tenant_owner', ${tenantId})`,
      );
    });

  beforeAll(async () => {
    db = await startTestDb();
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    tx = new TxService(drizzle(appPool));

    await seed(A.userId, A.tenantId, ids.ownerA);
    await seed(B.userId, B.tenantId, ids.ownerB);
    await tx.run({ userId: A.userId }, async (t) => {
      await t.execute(
        sql`insert into auth_identities (id, user_id, provider, subject) values (${ids.identityA}, ${A.userId}, 'google', 'g-sub-a')`,
      );
      await t.execute(
        sql`insert into refresh_tokens (id, user_id, session_id, family_id, token_hash, expires_at)
            values (${ids.tokenA}, ${A.userId}, ${randomUUID()}, ${randomUUID()}, 'hash-a', now() + interval '30 days')`,
      );
      await t.execute(
        sql`insert into memberships (id, user_id, role) values (${ids.parentA}, ${A.userId}, 'parent')`,
      );
      await t.execute(
        sql`insert into memberships (id, user_id, role, tenant_id, status) values (${ids.revokedA}, ${A.userId}, 'teacher', ${B.tenantId}, 'revoked')`,
      );
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([appPool?.end(), worker?.end()]);
    await db?.container.stop();
  });

  it.each([
    ['users', () => A.userId],
    ['auth_identities', () => ids.identityA],
    ['refresh_tokens', () => ids.tokenA],
    ['memberships', () => ids.ownerA],
  ])('%s: B không đọc, sửa, xóa được dòng của A', async (table, rowId) => {
    await expectRowIsolated(tx, {
      table,
      rowId: rowId(),
      owner: A.userId,
      intruder: B.userId,
    });
  });

  it('A không tự cấp vai trò hay tạo dữ liệu đứng tên B', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into memberships (id, user_id, role, tenant_id) values (${randomUUID()}, ${B.userId}, 'tenant_owner', ${B.tenantId})`,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into users (id) values (${randomUUID()})`,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into refresh_tokens (id, user_id, session_id, family_id, token_hash, expires_at)
          values (${randomUUID()}, ${B.userId}, ${randomUUID()}, ${randomUUID()}, 'hash-x', now())`,
    );
  });

  it('staff_tenant_ids(): chỉ tenant mà user đang là nhân sự', async () => {
    const tenants = (userId: string | null) =>
      tx.run({ userId }, async (t) =>
        (
          await t.execute<{ id: string }>(
            sql`select app_private.staff_tenant_ids() as id`,
          )
        ).rows.map((r) => r.id),
      );
    // Vai trò phụ huynh và vai trò đã thu hồi ở tenant B không tính.
    expect(await tenants(A.userId)).toEqual([A.tenantId]);
    expect(await tenants(B.userId)).toEqual([B.tenantId]);
    expect(await tenants(null)).toEqual([]);
  });

  it('CHECK phạm vi vai trò: nhân sự phải có tenant, phụ huynh thì không', async () => {
    const insert = (role: string, tenantId: string | null) =>
      tx
        .run({ userId: A.userId }, (t) =>
          t.execute(
            sql`insert into memberships (id, user_id, role, tenant_id) values (${randomUUID()}, ${A.userId}, ${role}, ${tenantId})`,
          ),
        )
        .then(
          () => '',
          (e: Error) => (e.cause as Error).message,
        );
    expect(await insert('teacher', null)).toMatch(/memberships_scope_check/);
    expect(await insert('parent', A.tenantId)).toMatch(
      /memberships_scope_check/,
    );
    // Một vai trò cho mỗi phạm vi.
    expect(await insert('parent', null)).toMatch(
      /memberships_user_role_scope_uq/,
    );
  });

  it('cấp vai trò ghi audit_logs với actor; updated_at tự cập nhật', async () => {
    const before = (
      await worker.query('select updated_at from memberships where id = $1', [
        ids.ownerA,
      ])
    ).rows[0]?.updated_at as Date;
    await tx.run({ userId: A.userId }, (t) =>
      t.execute(
        sql`update memberships set status = 'revoked' where id = ${ids.ownerA}`,
      ),
    );
    const { rows } = await worker.query(
      `select tenant_id, actor_user_id, action from audit_logs
        where entity = 'memberships' and entity_id = $1 order by id`,
      [ids.ownerA],
    );
    expect(rows).toEqual([
      { tenant_id: A.tenantId, actor_user_id: A.userId, action: 'insert' },
      { tenant_id: A.tenantId, actor_user_id: A.userId, action: 'update' },
    ]);
    const after = (
      await worker.query('select updated_at from memberships where id = $1', [
        ids.ownerA,
      ])
    ).rows[0]?.updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
