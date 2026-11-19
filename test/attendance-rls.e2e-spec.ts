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
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

// S3-BE-01: attendance: RLS chéo tenant, ràng buộc duy nhất, khóa ngoại kép và trigger audit.
describe('attendance: RLS và ràng buộc', () => {
  let db: TestDb;
  let worker: pg.Pool;
  let appPool: pg.Pool;
  let tx: TxService;
  let A: SeededTenant;
  let B: SeededTenant;
  const ids = {
    classA: randomUUID(),
    sessionA: randomUUID(),
    studentA: randomUUID(),
    studentA2: randomUUID(),
    studentB: randomUUID(),
    attA: randomUUID(),
  };

  const asA = (q: ReturnType<typeof sql>) =>
    tx.run({ userId: A.userId }, (t) => t.execute(q));
  const row = (
    id: string,
    student: string,
    over: { mutation?: string | null; status?: string } = {},
  ) => sql`insert into attendance (id, tenant_id, session_id, student_id, status, client_mutation_id, client_updated_at)
    values (${id}, ${A.tenantId}, ${ids.sessionA}, ${student}, ${over.status ?? 'present'},
            ${over.mutation === undefined ? randomUUID() : over.mutation}, now())`;

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    A = await seedTenant(worker);
    B = await seedTenant(worker);
    await asA(sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
      values (${ids.classA}, ${A.tenantId}, ${A.branchId}, 'Toán', 'Toán', 9, 'online', '2026-12-14')`);
    await asA(sql`insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at)
      values (${ids.sessionA}, ${A.tenantId}, ${ids.classA}, '2026-12-15', now(), now() + interval '90 minutes')`);
    for (const [id, tenant, userId] of [
      [ids.studentA, A.tenantId, A.userId],
      [ids.studentA2, A.tenantId, A.userId],
      [ids.studentB, B.tenantId, B.userId],
    ] as const) {
      await tx.run({ userId }, (t) =>
        t.execute(
          sql`insert into students (id, tenant_id, full_name) values (${id}, ${tenant}, 'Học viên')`,
        ),
      );
    }
    await asA(row(ids.attA, ids.studentA));
  }, 120_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), appPool?.end()]);
    await db?.container.stop();
  });

  it('tenant B không đọc/sửa/xóa; thiếu app.user_id → 0 dòng', async () => {
    await expectRowIsolated(tx, {
      table: 'attendance',
      rowId: ids.attA,
      owner: A.userId,
      intruder: B.userId,
    });
  });

  it('B không ghi được dòng gắn tenant A', async () => {
    await expectInsertRejected(tx, B.userId, row(randomUUID(), ids.studentA2));
  });

  it('khóa ngoại kép: dòng của A không trỏ được học viên của tenant B', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      row(randomUUID(), ids.studentB),
      /attendance_tenant_student_fk/,
    );
  });

  it('unique (session_id, student_id): đồng bộ lại không tạo dòng trùng', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      row(randomUUID(), ids.studentA),
      /attendance_session_student_uq/,
    );
  });

  it('unique (tenant_id, client_mutation_id); dòng tạo ngầm (null) không đụng nhau', async () => {
    const m = randomUUID();
    await asA(row(randomUUID(), ids.studentA2, { mutation: m }));
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into attendance (id, tenant_id, session_id, student_id, status, client_mutation_id, client_updated_at)
          values (${randomUUID()}, ${A.tenantId}, ${ids.sessionA}, ${randomUUID()}, 'present', ${m}, now())`,
      /attendance_tenant_mutation_uq|attendance_tenant_student_fk/,
    );
    const extra = randomUUID();
    await tx.run({ userId: A.userId }, async (t) => {
      await t.execute(
        sql`insert into students (id, tenant_id, full_name) values (${extra}, ${A.tenantId}, 'Em ba')`,
      );
      await t.execute(row(randomUUID(), extra, { mutation: null }));
    });
  });

  it('CHECK trạng thái chỉ 4 giá trị', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      row(randomUUID(), randomUUID(), { status: 'absent' }),
      /attendance_status_check/,
    );
  });

  it('trigger audit: insert và update ghi audit_logs với người sửa, trạng thái trước/sau và session_id', async () => {
    const id = randomUUID();
    const student = randomUUID();
    await tx.run({ userId: A.userId }, async (t) => {
      await t.execute(
        sql`insert into students (id, tenant_id, full_name) values (${student}, ${A.tenantId}, 'Em tư')`,
      );
      await t.execute(row(id, student, { status: 'unexcused' }));
    });
    await asA(sql`update attendance set status = 'present' where id = ${id}`);
    const { rows } = await worker.query(
      `select action, actor_user_id, before_data->>'status' as before, after_data->>'status' as after,
              after_data->>'session_id' as session_id
         from audit_logs where tenant_id = $1 and entity = 'attendance' and entity_id = $2 order by id`,
      [A.tenantId, id],
    );
    expect(rows).toEqual([
      {
        action: 'insert',
        actor_user_id: A.userId,
        before: null,
        after: 'unexcused',
        session_id: ids.sessionA,
      },
      {
        action: 'update',
        actor_user_id: A.userId,
        before: 'unexcused',
        after: 'present',
        session_id: ids.sessionA,
      },
    ]);
  });

  it('M4: hàm lịch sử chỉ trả cho tenant_owner của tenant; giáo viên, người tenant khác, thiếu user đều rỗng', async () => {
    const teacher = await seedMember(worker, A.tenantId, 'teacher');
    const call = (userId: string | null) =>
      tx.run(
        { userId },
        async (t) =>
          (
            await t.execute(
              sql`select id from app_private.attendance_history(${A.tenantId}::uuid, ${ids.sessionA}::uuid, null, 10)`,
            )
          ).rows.length,
      );
    expect(await call(A.userId)).toBeGreaterThan(0);
    expect(await call(teacher)).toBe(0);
    expect(await call(B.userId)).toBe(0);
    expect(await call(null)).toBe(0);
  });

  it('M4: policy owner của audit_logs không còn mở cho entity khác', async () => {
    const { rows } = await worker.query(
      `select qual from pg_policies where tablename = 'audit_logs' and policyname = 'audit_logs_owner_select'`,
    );
    expect(rows[0].qual).toContain("entity = 'attendance'");
    expect(rows[0].qual).toContain('staff_tenant_ids');
  });
});
