import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';

// S0-BE-09: bảng hạ tầng + trigger audit tổng quát (migration 0001, 0002).
describe('audit_logs + bảng hạ tầng', () => {
  let db: TestDb;
  let owner: pg.Pool;
  let appPool: pg.Pool;
  /** teachhub_worker (BYPASSRLS): đọc audit_logs, ghi job_runs như worker thật. */
  let worker: pg.Pool;
  let tx: TxService;
  const actor = randomUUID();
  const tenant = randomUUID();

  beforeAll(async () => {
    db = await startTestDb();
    owner = new pg.Pool({ connectionString: db.url('teachhub_owner') });
    await owner.query(`
      create table audit_probes (id uuid primary key, tenant_id uuid not null, note text, phone text);
      alter table audit_probes enable row level security;
      alter table audit_probes force row level security;
      create policy audit_probes_app_all on audit_probes for all to teachhub_app using (true) with check (true);
      select app_private.enable_audit('audit_probes');
    `);
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    tx = new TxService(drizzle(appPool));
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), appPool?.end(), worker?.end()]);
    await db?.container.stop();
  });

  const auditRows = async (entityId: string) =>
    (
      await worker.query(
        `select tenant_id, actor_user_id, entity, action, before_data, after_data
           from audit_logs where entity_id = $1 order by id`,
        [entityId],
      )
    ).rows;

  it('ghi một bản ghi thăm dò → có dòng audit_logs đúng actor, bỏ phone', async () => {
    const id = randomUUID();
    await tx.run({ userId: actor }, (t) =>
      t.execute(
        sql`insert into audit_probes (id, tenant_id, note, phone) values (${id}, ${tenant}, 'a', '0901')`,
      ),
    );
    await tx.run({ userId: actor }, (t) =>
      t.execute(sql`update audit_probes set note = 'b' where id = ${id}`),
    );
    // UPDATE không đổi gì → không ghi audit.
    await tx.run({ userId: actor }, (t) =>
      t.execute(sql`update audit_probes set note = 'b' where id = ${id}`),
    );
    // Chỉ đổi phone → vẫn có dòng audit, không lộ giá trị phone.
    await tx.run({ userId: actor }, (t) =>
      t.execute(sql`update audit_probes set phone = '0999' where id = ${id}`),
    );
    await tx.run({ userId: null }, (t) =>
      t.execute(sql`delete from audit_probes where id = ${id}`),
    );

    const rows = await auditRows(id);
    expect(rows.map((r) => r.action)).toEqual([
      'insert',
      'update',
      'update',
      'delete',
    ]);
    expect(rows[0]).toMatchObject({
      tenant_id: tenant,
      actor_user_id: actor,
      entity: 'audit_probes',
      before_data: null,
      after_data: { id, tenant_id: tenant, note: 'a' },
    });
    expect(rows[0].after_data).not.toHaveProperty('phone');
    expect(rows[1]).toMatchObject({
      before_data: { note: 'a' },
      after_data: { note: 'b' },
    });
    expect(rows[2]?.after_data).toMatchObject({ redacted_changed: true });
    expect(JSON.stringify(rows[2])).not.toContain('0999');
    expect(rows[3]).toMatchObject({ actor_user_id: null, after_data: null });
  });

  it('api không đọc, không ghi, không sửa được audit_logs', async () => {
    const read = await tx.run({ userId: actor }, (t) =>
      t.execute(sql`select count(*)::int as n from audit_logs`),
    );
    expect(read.rows[0]?.n).toBe(0);
    await expect(
      appPool.query(
        `insert into audit_logs (entity, action) values ('x', 'insert')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`delete from audit_logs`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('phân vùng tháng tự tạo khi thiếu, có RLS để không đọc thẳng được', async () => {
    await owner.query(
      `select app_private.ensure_audit_partition('2031-02-10T00:00:00Z')`,
    );
    const part = await owner.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'audit_logs_y2031m02'`,
    );
    expect(part.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    // Gọi lại không lỗi.
    await owner.query(
      `select app_private.ensure_audit_partition('2031-02-28T23:59:59Z')`,
    );
  });

  it('idempotency_keys: api chỉ thấy khóa của user hiện tại; job_runs: api không thấy', async () => {
    const other = randomUUID();
    for (const userId of [actor, other])
      await tx.run({ userId }, (t) =>
        t.execute(
          sql`insert into idempotency_keys (id, user_id, endpoint, key, request_hash, status_code)
              values (${randomUUID()}, ${userId}, 'POST /v1/x', 'k1', 'h', 201)`,
        ),
      );
    const mine = await tx.run({ userId: actor }, (t) =>
      t.execute(sql`select count(*)::int as n from idempotency_keys`),
    );
    expect(mine.rows[0]?.n).toBe(1);
    await expect(
      tx.run({ userId: actor }, (t) =>
        t.execute(
          sql`insert into idempotency_keys (id, user_id, endpoint, key, request_hash, status_code)
              values (${randomUUID()}, ${other}, 'POST /v1/x', 'k2', 'h', 201)`,
        ),
      ),
    ).rejects.toThrow();

    await worker.query(
      `insert into job_runs (id, job, status) values ($1, 'probe', 'running')`,
      [randomUUID()],
    );
    const jobs = await appPool.query(`select count(*)::int as n from job_runs`);
    expect(jobs.rows[0]?.n).toBe(0);
  });
});
