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

// S4-BE-01: invites, consents: RLS chéo tenant, ràng buộc, consents chỉ ghi thêm.
describe('invites/consents: RLS và ràng buộc', () => {
  let db: TestDb;
  let worker: pg.Pool;
  let owner: pg.Pool;
  let appPool: pg.Pool;
  let tx: TxService;
  let A: SeededTenant;
  let B: SeededTenant;
  let parentUser: string;
  const ids = {
    studentA: randomUUID(),
    guardianA: randomUUID(),
    guardianA2: randomUUID(),
    inviteA: randomUUID(),
    consentP: randomUUID(),
  };
  const hash = () => randomUUID().replaceAll('-', '');

  const insertInvite = (
    over: Partial<{
      id: string;
      guardian: string;
      student: string;
      tenant: string;
      token: string;
      code: string;
      status: string;
    }> = {},
  ) =>
    sql`insert into invites (id, tenant_id, student_id, guardian_id, token_hash, short_code_hash, short_code_expires_at, expires_at, status)
        values (${over.id ?? randomUUID()}, ${over.tenant ?? A.tenantId}, ${over.student ?? ids.studentA},
                ${over.guardian ?? ids.guardianA}, ${over.token ?? hash()}, ${over.code ?? hash()},
                now() + interval '2 days', now() + interval '7 days', ${over.status ?? 'pending'})`;

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    owner = new pg.Pool({ connectionString: db.url('teachhub_owner') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    A = await seedTenant(worker);
    B = await seedTenant(worker);
    parentUser = randomUUID();
    await worker.query(`insert into users (id, email) values ($1, $2)`, [
      parentUser,
      `${parentUser}@example.com`,
    ]);
    await worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Học viên A')`,
      [ids.studentA, A.tenantId],
    );
    for (const g of [ids.guardianA, ids.guardianA2]) {
      await worker.query(
        `insert into guardians (id, tenant_id, student_id, full_name) values ($1, $2, $3, 'PH')`,
        [g, A.tenantId, ids.studentA],
      );
    }
    await tx.run({ userId: A.userId }, (t) =>
      t.execute(insertInvite({ id: ids.inviteA })),
    );
    await tx.run({ userId: parentUser }, (t) =>
      t.execute(
        sql`insert into consents (id, user_id, role, terms_version) values (${ids.consentP}, ${parentUser}, 'parent', '2026-12-01')`,
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), owner?.end(), appPool?.end()]);
    await db?.container.stop();
  });

  it('invites: tenant B không đọc/sửa/xóa; thiếu app.user_id và phụ huynh chưa có quyền → 0 dòng', async () => {
    await expectRowIsolated(tx, {
      table: 'invites',
      rowId: ids.inviteA,
      owner: A.userId,
      intruder: B.userId,
    });
    const n = await tx.run(
      { userId: parentUser },
      async (t) => (await t.execute(sql`select 1 from invites`)).rowCount,
    );
    expect(n).toBe(0);
  });

  it('invites: B không ghi được lời mời gắn tenant A; không gắn phụ huynh của học viên khác (FK kép)', async () => {
    await expectInsertRejected(tx, B.userId, insertInvite());
    const otherStudent = randomUUID();
    await worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Học viên khác')`,
      [otherStudent, A.tenantId],
    );
    await expectInsertRejected(
      tx,
      A.userId,
      insertInvite({ student: otherStudent, status: 'revoked' }),
      /invites_tenant_student_guardian_fk/,
    );
  });

  it('token_hash duy nhất; mã ngắn duy nhất khi còn hiệu lực, dùng lại được khi lời mời cũ đã hết hiệu lực; một lời mời pending mỗi phụ huynh', async () => {
    const token = hash();
    const code = hash();
    await tx.run({ userId: A.userId }, (t) =>
      t.execute(insertInvite({ guardian: ids.guardianA2, token, code })),
    );
    await expectInsertRejected(
      tx,
      A.userId,
      insertInvite({ guardian: ids.guardianA, token }),
      /invites_tokenHash_unique|token_hash/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      insertInvite({ guardian: ids.guardianA, code }),
      /invites_short_code_pending_uq/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      insertInvite({ guardian: ids.guardianA2 }),
      /invites_guardian_pending_uq/,
    );
    // Lời mời cũ bị thu hồi → mã cũ không còn chiếm chỗ.
    await tx.run({ userId: A.userId }, async (t) => {
      await t.execute(
        sql`update invites set status = 'revoked' where guardian_id = ${ids.guardianA2}`,
      );
      await t.execute(insertInvite({ guardian: ids.guardianA2, code }));
    });
  });

  it('consents: user chỉ đọc/ghi dòng của mình; người khác và thiếu app.user_id thấy 0 dòng, không ghi hộ được', async () => {
    const seen = (userId: string | null) =>
      tx.run(
        { userId },
        async (t) =>
          (
            await t.execute(
              sql`select 1 from consents where id = ${ids.consentP}`,
            )
          ).rowCount,
      );
    expect(await seen(parentUser)).toBe(1);
    expect(await seen(A.userId)).toBe(0);
    expect(await seen(null)).toBe(0);
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into consents (id, user_id, role, terms_version) values (${randomUUID()}, ${parentUser}, 'parent', 'x')`,
    );
  });

  it('consents chỉ ghi thêm: UPDATE/DELETE/TRUNCATE bị chặn với api, worker (BYPASSRLS) và owner (0 dòng)', async () => {
    for (const [name, pool] of [
      ['app', appPool],
      ['worker', worker],
      ['owner', owner],
    ] as const) {
      for (const stmt of [
        `update consents set terms_version = 'đã sửa'`,
        `delete from consents`,
        `truncate consents`,
      ]) {
        // app.user_id đúng chủ dòng để policy cho phép thấy dòng: chỉ quyền/trigger mới chặn được.
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query(`select set_config('app.user_id', $1, true)`, [
            parentUser,
          ]);
          // owner không có policy trên consents → UPDATE/DELETE thấy 0 dòng (không sửa được gì); TRUNCATE vướng trigger.
          const res = await c.query(stmt).then(
            (r) => r,
            (e: Error) => e,
          );
          if (res instanceof Error) {
            expect(res.message, `${name}: ${stmt}`).toMatch(
              /permission denied|chỉ ghi thêm/,
            );
          } else {
            expect(name, `${name}: ${stmt}`).toBe('owner');
            expect(res.rowCount, `${name}: ${stmt}`).toBe(0);
          }
        } finally {
          await c.query('rollback');
          c.release();
        }
      }
    }
    const [r] = (
      await worker.query(`select terms_version from consents where id = $1`, [
        ids.consentP,
      ])
    ).rows;
    expect(r).toEqual({ terms_version: '2026-12-01' });
  });
});
