import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';
import {
  type Actors,
  expectInsertRejected,
  expectRowIsolated,
  makeActors,
} from './support/isolation.js';

// Mẫu dùng bộ khung chéo tenant trên bảng thăm dò. Bảng thật (Sprint 1+) thay probe_* bằng
// memberships/guardians thật và app_private.staff_tenant_ids()/linked_student_ids() (§4.5).
describe('bộ khung chéo tenant (mẫu trên bảng thăm dò)', () => {
  let db: TestDb;
  let appPool: pg.Pool;
  let tx: TxService;
  let actors: Actors;
  const rows = {
    a: randomUUID(),
    b: randomUUID(),
    x: randomUUID(),
    y: randomUUID(),
  };

  beforeAll(async () => {
    db = await startTestDb();
    actors = makeActors();
    const { A, B, X, Y } = actors;
    const owner = new pg.Client({ connectionString: db.url('teachhub_owner') });
    await owner.connect();
    await owner.query(`
      create table probe_staff (user_id uuid, tenant_id uuid);
      create table probe_guardians (user_id uuid, student_id uuid);
      create function app_private.probe_tenant_ids() returns setof uuid
        language sql stable security definer set search_path = '' as $$
        select tenant_id from public.probe_staff
         where user_id = nullif(current_setting('app.user_id', true), '')::uuid $$;
      create function app_private.probe_student_ids() returns setof uuid
        language sql stable security definer set search_path = '' as $$
        select student_id from public.probe_guardians
         where user_id = nullif(current_setting('app.user_id', true), '')::uuid $$;

      create table probe_records (id uuid primary key, tenant_id uuid not null, student_id uuid);
      alter table probe_records enable row level security;
      alter table probe_records force row level security;
      create policy probe_records_staff_all on probe_records for all to teachhub_app
        using (tenant_id in (select app_private.probe_tenant_ids()))
        with check (tenant_id in (select app_private.probe_tenant_ids()));
      create policy probe_records_family_read on probe_records for select to teachhub_app
        using (student_id in (select app_private.probe_student_ids()));
    `);
    await owner.query(`insert into probe_staff values ($1, $2), ($3, $4)`, [
      A.userId,
      A.tenantId,
      B.userId,
      B.tenantId,
    ]);
    await owner.query(`insert into probe_guardians values ($1, $2), ($3, $4)`, [
      X.userId,
      X.studentId,
      Y.userId,
      Y.studentId,
    ]);
    await owner.end();

    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    const insert = (
      userId: string,
      id: string,
      tenantId: string,
      studentId: string | null,
    ) =>
      tx.run({ userId }, (t) =>
        t.execute(
          sql`insert into probe_records values (${id}, ${tenantId}, ${studentId})`,
        ),
      );
    await insert(A.userId, rows.a, A.tenantId, null);
    await insert(B.userId, rows.b, B.tenantId, null);
    await insert(A.userId, rows.x, A.tenantId, X.studentId);
    await insert(A.userId, rows.y, A.tenantId, Y.studentId);
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await db?.container.stop();
  });

  it('giáo viên tenant A không đọc/sửa/xóa bản ghi tenant B và ngược lại', async () => {
    const { A, B } = actors;
    await expectRowIsolated(tx, {
      table: 'probe_records',
      rowId: rows.b,
      owner: B.userId,
      intruder: A.userId,
    });
    await expectRowIsolated(tx, {
      table: 'probe_records',
      rowId: rows.a,
      owner: A.userId,
      intruder: B.userId,
    });
  });

  it('giáo viên tenant A không ghi được bản ghi vào tenant B', async () => {
    const { A, B } = actors;
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into probe_records values (${randomUUID()}, ${B.tenantId}, null)`,
    );
  });

  it('phụ huynh X không đọc được dữ liệu học viên Y (cùng tenant)', async () => {
    const { X, Y } = actors;
    await expectRowIsolated(tx, {
      table: 'probe_records',
      rowId: rows.y,
      owner: Y.userId,
      intruder: X.userId,
    });
  });
});
