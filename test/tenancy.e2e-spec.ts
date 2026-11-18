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

// S1-BE-02: tenants, branches, plans, subscriptions (migration 0005, 0006).
describe('tenancy: tenants, branches, plans, subscriptions', () => {
  let db: TestDb;
  let owner: pg.Pool;
  let appPool: pg.Pool;
  let worker: pg.Pool;
  let tx: TxService;
  const { A, B } = makeActors();
  const rows = {
    A: { branch: randomUUID(), sub: randomUUID() },
    B: { branch: randomUUID(), sub: randomUUID() },
  };

  /** Như POST /workspaces (S1-BE-08): user + tenant + chi nhánh mặc định + chủ tenant + gói free. */
  const workspace = async (
    userId: string,
    tenantId: string,
    r: { branch: string; sub: string },
  ) => {
    await tx.run({ userId }, (t) =>
      t.execute(sql`insert into users (id) values (${userId})`),
    );
    for (const [q, p] of [
      [
        `insert into tenants (id, type, name) values ($1, 'teacher', 'Lớp cô Lan')`,
        [tenantId],
      ],
      [
        `insert into branches (id, tenant_id, name, is_default) values ($1, $2, 'Mặc định', true)`,
        [r.branch, tenantId],
      ],
      [
        `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, 'tenant_owner', $3)`,
        [randomUUID(), userId, tenantId],
      ],
      [
        `insert into subscriptions (id, tenant_id, plan_code) values ($1, $2, 'free')`,
        [r.sub, tenantId],
      ],
    ] as const) {
      await asPrivileged(worker, userId, q, [...p]);
    }
  };

  beforeAll(async () => {
    db = await startTestDb();
    owner = new pg.Pool({ connectionString: db.url('teachhub_owner') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    tx = new TxService(drizzle(appPool));
    await workspace(A.userId, A.tenantId, rows.A);
    await workspace(B.userId, B.tenantId, rows.B);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), appPool?.end(), worker?.end()]);
    await db?.container.stop();
  });

  it.each([
    ['tenants', () => A.tenantId],
    ['branches', () => rows.A.branch],
    ['subscriptions', () => rows.A.sub],
  ])('%s: B không đọc, sửa, xóa được dòng của A', async (table, rowId) => {
    await expectRowIsolated(tx, {
      table,
      rowId: rowId(),
      owner: A.userId,
      intruder: B.userId,
    });
  });

  it('A không tạo tenant, không thêm chi nhánh vào tenant của B', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into tenants (id, type, name) values (${randomUUID()}, 'teacher', 'x')`,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into branches (id, tenant_id, name) values (${randomUUID()}, ${B.tenantId}, 'x')`,
    );
  });

  it('A sửa được tenant và chi nhánh của mình', async () => {
    const changed = await tx.run({ userId: A.userId }, async (t) => {
      const a = await t.execute(
        sql`update tenants set name = 'Lớp cô Lan (Toán)' where id = ${A.tenantId}`,
      );
      const b = await t.execute(
        sql`insert into branches (id, tenant_id, name) values (${randomUUID()}, ${A.tenantId}, 'Cơ sở 2')`,
      );
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    });
    expect(changed).toBe(2);
  });

  it('A không tự nâng gói: subscriptions chỉ đọc với app', async () => {
    const changed = await tx.run(
      { userId: A.userId },
      async (t) =>
        (
          await t.execute(
            sql`update subscriptions set plan_code = 'pro', status = 'active' where tenant_id = ${A.tenantId}`,
          )
        ).rowCount,
    );
    expect(changed).toBe(0);
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into subscriptions (id, tenant_id, plan_code) values (${randomUUID()}, ${A.tenantId}, 'pro')`,
    );
  });

  it('vai trò của tenant A không gắn được chi nhánh của tenant B', async () => {
    const err = await asPrivileged(
      worker,
      A.userId,
      `insert into memberships (id, user_id, role, tenant_id, branch_id) values ($1, $2, 'teacher', $3, $4)`,
      [randomUUID(), A.userId, A.tenantId, rows.B.branch],
    ).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(err).toMatch(/memberships_tenant_branch_fk/);
  });

  it('mỗi tenant chỉ một chi nhánh mặc định', async () => {
    const err = await asPrivileged(
      worker,
      A.userId,
      `insert into branches (id, tenant_id, name, is_default) values ($1, $2, 'x', true)`,
      [randomUUID(), A.tenantId],
    ).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(err).toMatch(/branches_tenant_default_uq/);
  });

  it('plans: seed free/pro, gọi lại không nhân bản; app đọc được, không sửa được', async () => {
    await owner.query('select app_private.upsert_plans()');
    await owner.query('select app_private.upsert_plans()');
    const plans = await tx.run(
      { userId: A.userId },
      async (t) =>
        (
          await t.execute<{ code: string; limits: unknown }>(
            sql`select code, limits from plans order by code`,
          )
        ).rows,
    );
    expect(plans).toEqual([
      {
        code: 'free',
        limits: { max_active_classes: 3, max_active_students: 20 },
      },
      {
        code: 'pro',
        limits: { max_active_classes: null, max_active_students: null },
      },
    ]);
    const changed = await tx.run(
      { userId: A.userId },
      async (t) =>
        (
          await t.execute(
            sql`update plans set limits = '{}' where code = 'free'`,
          )
        ).rowCount,
    );
    expect(changed).toBe(0);
  });

  it('đổi gói ghi audit_logs', async () => {
    await asPrivileged(
      worker,
      A.userId,
      `update subscriptions set plan_code = 'pro', status = 'trialing' where id = $1`,
      [rows.A.sub],
    );
    const { rows: audit } = await worker.query(
      `select tenant_id, action from audit_logs where entity = 'subscriptions' and entity_id = $1 order by id`,
      [rows.A.sub],
    );
    expect(audit).toEqual([
      { tenant_id: A.tenantId, action: 'insert' },
      { tenant_id: A.tenantId, action: 'update' },
    ]);
  });
});
