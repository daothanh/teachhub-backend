import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';
import {
  asPrivileged,
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

  const privileged = (userId: string, query: string, params: unknown[]) =>
    asPrivileged(worker, userId, query, params);

  /** User tự tạo hồ sơ của mình (RLS `with check`); vai trò chủ tenant cấp qua đường đặc quyền. */
  const seed = async (userId: string, tenantId: string, ownerId: string) => {
    await tx.run({ userId }, (t) =>
      t.execute(
        sql`insert into users (id, email) values (${userId}, ${`${userId}@test.vn`})`,
      ),
    );
    await privileged(
      userId,
      `insert into tenants (id, type, name) values ($1, 'teacher', 'T')`,
      [tenantId],
    );
    await privileged(
      userId,
      `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, 'tenant_owner', $3)`,
      [ownerId, userId, tenantId],
    );
  };

  beforeAll(async () => {
    db = await startTestDb();
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    tx = new TxService(drizzle(appPool));

    await seed(A.userId, A.tenantId, ids.ownerA);
    await seed(B.userId, B.tenantId, ids.ownerB);
    await tx.run({ userId: A.userId }, async (t) => {
      await t.execute(
        sql`insert into refresh_tokens (id, user_id, session_id, family_id, token_hash, expires_at)
            values (${ids.tokenA}, ${A.userId}, ${randomUUID()}, ${randomUUID()}, 'hash-a', now() + interval '30 days')`,
      );
      await t.execute(
        sql`insert into memberships (id, user_id, role) values (${ids.parentA}, ${A.userId}, 'parent')`,
      );
    });
    // Identity chỉ tạo qua app_private.sign_in_identity (migration 0007).
    await privileged(
      A.userId,
      `insert into auth_identities (id, user_id, provider, subject) values ($1, $2, 'google', 'g-sub-a')`,
      [ids.identityA, A.userId],
    );
    await privileged(
      A.userId,
      `insert into memberships (id, user_id, role, tenant_id, status) values ($1, $2, 'teacher', $3, 'revoked')`,
      [ids.revokedA, A.userId, B.tenantId],
    );
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

  it('A không tự cấp vai trò nhân sự, kể cả ở tenant của mình', async () => {
    for (const [role, tenantId] of [
      ['tenant_owner', B.tenantId],
      ['teacher', B.tenantId],
      ['teacher', A.tenantId],
    ] as const) {
      await expectInsertRejected(
        tx,
        A.userId,
        sql`insert into memberships (id, user_id, role, tenant_id) values (${randomUUID()}, ${A.userId}, ${role}, ${tenantId})`,
      );
    }
    // Học sinh gắn hồ sơ học viên chỉ qua lời mời.
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into memberships (id, user_id, role, student_id) values (${randomUUID()}, ${A.userId}, 'student', ${randomUUID()})`,
    );
  });

  it('A không kích hoạt lại hay đổi vai trò của chính mình', async () => {
    const changed = await tx.run({ userId: A.userId }, async (t) => {
      const a = await t.execute(
        sql`update memberships set status = 'active' where id = ${ids.revokedA}`,
      );
      const b = await t.execute(
        sql`update memberships set role = 'tenant_owner', tenant_id = ${B.tenantId} where id = ${ids.parentA}`,
      );
      const c = await t.execute(
        sql`delete from memberships where id = ${ids.ownerA}`,
      );
      return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
    });
    expect(changed).toBe(0);
  });

  it('app không tự gắn identity (kể cả cho chính mình): chỉ qua sign_in_identity', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into auth_identities (id, user_id, provider, subject) values (${randomUUID()}, ${A.userId}, 'google', 'g-sub-victim')`,
    );
  });

  it('sign_in_identity: identity có sẵn → user cũ; email đã có → gắn vào user đó; mới → tạo user', async () => {
    const call = (provider: string, subject: string, email: string) =>
      tx.run(
        { userId: null },
        async (t) =>
          (
            await t.execute<{ id: string }>(
              sql`select app_private.sign_in_identity(${provider}, ${subject}, ${email}, ${randomUUID()}, ${randomUUID()}) as id`,
            )
          ).rows[0]!.id,
      );
    expect(await call('google', 'g-sub-a', 'khac@test.vn')).toBe(A.userId);
    expect(
      await call('email', `${A.userId}@test.vn`, `${A.userId}@test.vn`),
    ).toBe(A.userId);
    const fresh = await call('email', 'moi@test.vn', 'moi@test.vn');
    expect([A.userId, B.userId]).not.toContain(fresh);
    expect(await call('email', 'moi@test.vn', 'moi@test.vn')).toBe(fresh);
  });

  it('A không tạo dữ liệu đứng tên B', async () => {
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
      privileged(
        A.userId,
        `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, $3, $4)`,
        [randomUUID(), A.userId, role, tenantId],
      ).then(
        () => '',
        (e: Error) => e.message,
      );
    expect(await insert('teacher', null)).toMatch(/memberships_scope_check/);
    expect(await insert('parent', A.tenantId)).toMatch(
      /memberships_scope_check/,
    );
    // Một vai trò cho mỗi phạm vi — kể cả đường app tự thêm vai trò phụ huynh.
    const again = await tx
      .run({ userId: A.userId }, (t) =>
        t.execute(
          sql`insert into memberships (id, user_id, role) values (${randomUUID()}, ${A.userId}, 'parent')`,
        ),
      )
      .then(
        () => '',
        (e: Error) => (e.cause as Error).message,
      );
    expect(again).toMatch(/memberships_user_role_scope_uq/);
  });

  it('cấp vai trò ghi audit_logs với actor; updated_at tự cập nhật', async () => {
    const before = (
      await worker.query('select updated_at from memberships where id = $1', [
        ids.ownerA,
      ])
    ).rows[0]?.updated_at as Date;
    await privileged(
      A.userId,
      `update memberships set status = 'revoked' where id = $1`,
      [ids.ownerA],
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
