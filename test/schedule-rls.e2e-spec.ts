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

// S2-BE-07: schedule_rules + sessions: RLS chéo tenant và ràng buộc sinh buổi idempotent.
describe('schedule_rules/sessions: RLS và ràng buộc', () => {
  let db: TestDb;
  let worker: pg.Pool;
  let appPool: pg.Pool;
  let tx: TxService;
  let A: SeededTenant;
  let B: SeededTenant;
  const ids = {
    classA: randomUUID(),
    ruleA: randomUUID(),
    sessionA: randomUUID(),
  };

  const asA = (q: ReturnType<typeof sql>) =>
    tx.run({ userId: A.userId }, (t) => t.execute(q));
  const session = (id: string, ruleId: string, date: string) =>
    sql`insert into sessions (id, tenant_id, class_id, rule_id, session_date, starts_at, ends_at)
        values (${id}, ${A.tenantId}, ${ids.classA}, ${ruleId}, ${date},
                (${date}::date + time '18:00') at time zone 'Asia/Ho_Chi_Minh',
                (${date}::date + time '19:30') at time zone 'Asia/Ho_Chi_Minh')`;

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    A = await seedTenant(worker);
    B = await seedTenant(worker);
    await asA(sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
      values (${ids.classA}, ${A.tenantId}, ${A.branchId}, 'Toán', 'Toán', 9, 'online', '2026-12-14')`);
    await asA(sql`insert into schedule_rules (id, tenant_id, class_id, weekday, start_time, duration_min)
      values (${ids.ruleA}, ${A.tenantId}, ${ids.classA}, 2, '18:00', 90)`);
    await asA(session(ids.sessionA, ids.ruleA, '2026-12-15'));
  }, 120_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), appPool?.end()]);
    await db?.container.stop();
  });

  it.each([
    ['schedule_rules', 'ruleA'],
    ['sessions', 'sessionA'],
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

  it('B không ghi được dòng gắn tenant A', async () => {
    await expectInsertRejected(
      tx,
      B.userId,
      sql`insert into schedule_rules (id, tenant_id, class_id, weekday, start_time, duration_min)
          values (${randomUUID()}, ${A.tenantId}, ${ids.classA}, 3, '18:00', 90)`,
    );
  });

  it('unique (rule_id, session_date): sinh lại cùng quy tắc + ngày không tạo buổi trùng', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      session(randomUUID(), ids.ruleA, '2026-12-15'),
      /sessions_rule_date_uq/,
    );
    await asA(session(randomUUID(), ids.ruleA, '2026-12-22'));
  });

  it('CHECK: thứ ngoài 1-7, thời lượng ngoài 15-480, vượt 24:00, trùng (thứ + giờ), buổi kết thúc trước bắt đầu', async () => {
    const rule = (w: number, st: string, d: number) =>
      sql`insert into schedule_rules (id, tenant_id, class_id, weekday, start_time, duration_min)
          values (${randomUUID()}, ${A.tenantId}, ${ids.classA}, ${w}, ${st}, ${d})`;
    await expectInsertRejected(
      tx,
      A.userId,
      rule(8, '18:00', 90),
      /schedule_rules_weekday_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      rule(3, '18:00', 10),
      /schedule_rules_duration_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      rule(3, '23:00', 90),
      /schedule_rules_within_day_check/,
    );
    await asA(rule(3, '23:00', 60)); // đúng 24:00 thì được
    await expectInsertRejected(
      tx,
      A.userId,
      rule(2, '18:00', 60),
      /schedule_rules_class_weekday_start_uq/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at)
          values (${randomUUID()}, ${A.tenantId}, ${ids.classA}, '2026-12-30', now(), now())`,
      /sessions_time_check/,
    );
  });

  it('xóa quy tắc thì buổi còn lại, rule_id về null (buổi đã dạy giữ nguyên)', async () => {
    const rule = randomUUID();
    const s = randomUUID();
    await asA(sql`insert into schedule_rules (id, tenant_id, class_id, weekday, start_time, duration_min)
      values (${rule}, ${A.tenantId}, ${ids.classA}, 5, '17:00', 60)`);
    await asA(session(s, rule, '2026-12-18'));
    await asA(sql`delete from schedule_rules where id = ${rule}`);
    const r = await worker.query(`select rule_id from sessions where id = $1`, [
      s,
    ]);
    expect(r.rows).toEqual([{ rule_id: null }]);
  });
});
