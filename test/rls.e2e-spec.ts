import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';

// Mẫu RLS (Mục 4.5): bảng nghiệp vụ thật áp dụng cùng khuôn từ Sprint 1.
describe('TxService + RLS', () => {
  let db: TestDb;
  let appPool: pg.Pool;
  let tx: TxService;
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    db = await startTestDb();
    const owner = new pg.Client({ connectionString: db.url('teachhub_owner') });
    await owner.connect();
    await owner.query(`
      create table rls_samples (id uuid primary key default gen_random_uuid(), owner_id uuid not null, note text);
      alter table rls_samples enable row level security;
      alter table rls_samples force row level security;
      create policy rls_samples_app_all on rls_samples for all to teachhub_app
        using (owner_id = nullif(current_setting('app.user_id', true), '')::uuid)
        with check (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
    `);
    await owner.end();
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await db?.container.stop();
  });

  const count = (userId: string | null) =>
    tx.run(
      { userId },
      async (t) =>
        (await t.execute(sql`select count(*)::int as n from rls_samples`))
          .rows[0]?.n,
    );

  it('user chỉ thấy dữ liệu của mình; thiếu app.user_id → 0 dòng', async () => {
    await tx.run({ userId: userA }, (t) =>
      t.execute(sql`insert into rls_samples (owner_id) values (${userA})`),
    );
    expect(await count(userA)).toBe(1);
    expect(await count(userB)).toBe(0);
    expect(await count(null)).toBe(0);
  });

  it('không ghi được bản ghi thuộc user khác (with check)', async () => {
    await expect(
      tx.run({ userId: userB }, (t) =>
        t.execute(sql`insert into rls_samples (owner_id) values (${userA})`),
      ),
    ).rejects.toThrow();
  });

  it('app.user_id không rò sang giao dịch sau (SET LOCAL)', async () => {
    const leaked = await appPool.query(
      `select current_setting('app.user_id', true) as v`,
    );
    expect(leaked.rows[0]?.v || '').toBe('');
  });

  // ADR-TH-BE-001 §2: api chạy bằng vai trò không vượt được RLS và không sở hữu bảng.
  it('teachhub_app không BYPASSRLS, không superuser, không sở hữu bảng nào', async () => {
    const role = await appPool.query(
      `select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await appPool.query(
      `select count(*)::int as n from pg_tables where tableowner = current_user`,
    );
    expect(owned.rows[0]?.n).toBe(0);
  });
});
