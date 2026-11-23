import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';
import {
  expectInsertRejected,
  expectRowIsolated,
} from './support/isolation.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

// S2-BE-02: bảng classes + RLS ép + audit.
describe('classes: RLS chéo tenant, ràng buộc, audit', () => {
  let db: TestDb;
  let worker: pg.Pool;
  let appPool: pg.Pool;
  let tx: TxService;
  let A: SeededTenant;
  let B: SeededTenant;
  const classA = randomUUID();

  const insertClass = (t: SeededTenant, id: string, extra = '') =>
    sql.raw(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, location, start_date ${extra ? ', ' + extra.split('|')[0] : ''})
       values ('${id}', '${t.tenantId}', '${t.branchId}', 'Toán 9A', 'Toán', 9, 'offline', 'Nhà', '2026-12-14' ${extra ? ', ' + extra.split('|')[1] : ''})`,
    );

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    A = await seedTenant(worker);
    B = await seedTenant(worker);
    await tx.run({ userId: A.userId }, (t) =>
      t.execute(insertClass(A, classA)),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), appPool?.end()]);
    await db?.container.stop();
  });

  it('giáo viên tenant B không đọc/sửa/xóa lớp của A; thiếu app.user_id → 0 dòng', async () => {
    await expectRowIsolated(tx, {
      table: 'classes',
      rowId: classA,
      owner: A.userId,
      intruder: B.userId,
    });
  });

  it('B không tạo được lớp gắn tenant A', async () => {
    await expectInsertRejected(tx, B.userId, insertClass(A, randomUUID()));
  });

  it('CHECK: ngày kết thúc trước ngày bắt đầu, khối ngoài 1-12, lớp tại chỗ thiếu địa điểm bị chặn', async () => {
    const bad = (extra: string, re: RegExp) =>
      expectInsertRejected(
        tx,
        A.userId,
        insertClass(A, randomUUID(), extra),
        re,
      );
    await bad(`end_date|'2026-12-01'`, /classes_end_date_check/);
    await bad(`status|'deleted'`, /classes_status_check/);
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
          values (${randomUUID()}, ${A.tenantId}, ${A.branchId}, 'x', 'x', 13, 'online', '2026-12-14')`,
      /classes_grade_check/,
    );
  });

  it('chi nhánh của tenant khác bị FK kép chặn', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
          values (${randomUUID()}, ${A.tenantId}, ${B.branchId}, 'x', 'x', 9, 'online', '2026-12-14')`,
      /classes_tenant_branch_fk/,
    );
  });

  it('thêm và sửa lớp để lại dòng audit_logs đúng tenant', async () => {
    await tx.run({ userId: A.userId }, (t) =>
      t.execute(sql`update classes set name = 'Toán 9B' where id = ${classA}`),
    );
    const { rows } = await worker.query(
      `select action, tenant_id from audit_logs where entity = 'classes' and entity_id = $1 order by id`,
      [classA],
    );
    expect(rows).toEqual([
      { action: 'insert', tenant_id: A.tenantId },
      { action: 'update', tenant_id: A.tenantId },
    ]);
  });
});
