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

// S2-BE-04: students, guardians, enrollments: RLS chéo tenant, tìm không dấu bằng index, ràng buộc.
describe('students/guardians/enrollments: RLS và ràng buộc', () => {
  let db: TestDb;
  let worker: pg.Pool;
  let appPool: pg.Pool;
  let tx: TxService;
  let A: SeededTenant;
  let B: SeededTenant;
  const ids = {
    classA: randomUUID(),
    studentA: randomUUID(),
    guardianA: randomUUID(),
    enrollA: randomUUID(),
  };

  const asA = (q: ReturnType<typeof sql>) =>
    tx.run({ userId: A.userId }, (t) => t.execute(q));

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    A = await seedTenant(worker);
    B = await seedTenant(worker);
    await asA(sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
      values (${ids.classA}, ${A.tenantId}, ${A.branchId}, 'Toán', 'Toán', 9, 'online', '2026-12-14')`);
    await asA(sql`insert into students (id, tenant_id, full_name, dob)
      values (${ids.studentA}, ${A.tenantId}, 'Nguyễn Đức Thắng', '2011-05-20')`);
    await asA(sql`insert into guardians (id, tenant_id, student_id, full_name, phone)
      values (${ids.guardianA}, ${A.tenantId}, ${ids.studentA}, 'Nguyễn Văn Hải', '0912345678')`);
    await asA(sql`insert into enrollments (id, tenant_id, class_id, student_id, joined_on)
      values (${ids.enrollA}, ${A.tenantId}, ${ids.classA}, ${ids.studentA}, '2026-12-14')`);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), appPool?.end()]);
    await db?.container.stop();
  });

  it.each([
    ['students', 'studentA'],
    ['guardians', 'guardianA'],
    ['enrollments', 'enrollA'],
  ] as const)(
    '%s: tenant B không đọc/sửa/xóa; thiếu app.user_id → 0 dòng',
    async (table, key) => {
      await expectRowIsolated(tx, {
        table,
        rowId: ids[key],
        owner: A.userId,
        intruder: B.userId,
      });
    },
  );

  it('B không ghi được dòng gắn tenant A; A không gắn học viên/lớp của B vào dòng của mình (FK kép)', async () => {
    await expectInsertRejected(
      tx,
      B.userId,
      sql`insert into students (id, tenant_id, full_name) values (${randomUUID()}, ${A.tenantId}, 'X')`,
    );
    const bStudent = randomUUID();
    await tx.run({ userId: B.userId }, (t) =>
      t.execute(
        sql`insert into students (id, tenant_id, full_name) values (${bStudent}, ${B.tenantId}, 'Học viên của B')`,
      ),
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into enrollments (id, tenant_id, class_id, student_id, joined_on)
          values (${randomUUID()}, ${A.tenantId}, ${ids.classA}, ${bStudent}, '2026-12-14')`,
      /enrollments_tenant_student_fk/,
    );
  });

  it('full_name_unaccent: bỏ dấu tiếng Việt (kể cả đ), chữ thường; tìm "duc thang" dùng được index', async () => {
    const r = await asA(
      sql`select full_name_unaccent as v from students where id = ${ids.studentA}`,
    );
    expect(r.rows[0]).toEqual({ v: 'nguyen duc thang' });
    // Bảng nhỏ thì planner chọn quét tuần tự; tắt seqscan để chứng minh index dùng được.
    const explain = (userId: string | null, pool?: pg.Pool) => {
      const q = `explain select id from students where ${pool ? '' : `tenant_id = '${A.tenantId}' and `}full_name_unaccent like '%duc thang%'`;
      if (pool)
        return pool.query(`set enable_seqscan = off`).then(() => pool.query(q));
      return tx.run({ userId }, async (t) => {
        await t.execute(sql`set local enable_seqscan = off`);
        return t.execute(sql.raw(q));
      });
    };
    const text = (r: { rows: Record<string, string>[] }) =>
      r.rows.map((x) => x['QUERY PLAN']).join('\n');
    // Vai trò không bị RLS: GIN trigram được chọn cho LIKE '%…%'.
    const one = new pg.Pool({
      connectionString: db.url('teachhub_worker'),
      max: 1,
    });
    expect(text(await explain(null, one))).toContain(
      'students_full_name_unaccent_trgm_idx',
    );
    await one.end();
    // teachhub_app: `textlike` không leakproof nên Postgres không cho dùng làm điều kiện index dưới RLS;
    // lọc `tenant_id = …` tường minh vẫn đi index btree, phần tên lọc trên tập của riêng tenant.
    expect(text(await explain(A.userId))).toContain(
      'students_tenant_status_idx',
    );
  });

  it('một học viên ở 2 lớp: 1 dòng students, 2 dòng enrollments; ghi danh mở trùng lớp bị chặn, ghi danh đã đóng thì mở lại được', async () => {
    const class2 = randomUUID();
    await asA(sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
      values (${class2}, ${A.tenantId}, ${A.branchId}, 'Lý', 'Lý', 9, 'online', '2026-12-14')`);
    await asA(sql`insert into enrollments (id, tenant_id, class_id, student_id, joined_on)
      values (${randomUUID()}, ${A.tenantId}, ${class2}, ${ids.studentA}, '2026-12-14')`);
    const n = await worker.query(
      `select (select count(*)::int from students where id = $1) s,
              (select count(*)::int from enrollments where student_id = $1) e`,
      [ids.studentA],
    );
    expect(n.rows[0]).toEqual({ s: 1, e: 2 });
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into enrollments (id, tenant_id, class_id, student_id, joined_on)
          values (${randomUUID()}, ${A.tenantId}, ${ids.classA}, ${ids.studentA}, '2026-12-20')`,
      /enrollments_open_uq/,
    );
    await asA(
      sql`update enrollments set left_on = '2026-12-31' where id = ${ids.enrollA}`,
    );
    await asA(sql`insert into enrollments (id, tenant_id, class_id, student_id, joined_on)
      values (${randomUUID()}, ${A.tenantId}, ${ids.classA}, ${ids.studentA}, '2027-01-05')`);
    await expectInsertRejected(
      tx,
      A.userId,
      sql`update enrollments set left_on = '2020-01-01' where id = ${ids.enrollA}`,
      /enrollments_left_on_check/,
    );
  });

  it('tối đa 2 phụ huynh chưa gỡ; gỡ một người thì thêm được người khác', async () => {
    const add = (id: string) =>
      sql`insert into guardians (id, tenant_id, student_id, full_name)
          values (${id}, ${A.tenantId}, ${ids.studentA}, 'PH')`;
    const second = randomUUID();
    await asA(add(second));
    await expectInsertRejected(
      tx,
      A.userId,
      add(randomUUID()),
      /đã có 2 phụ huynh/,
    );
    await asA(
      sql`update guardians set deleted_at = now() where id = ${second}`,
    );
    await asA(add(randomUUID()));
  });
});
