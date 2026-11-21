import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  assertDevEnvironment,
  assertLocalDatabase,
  linkParents,
} from '../scripts/seed-link-guardians.mjs';
import { startTestDb, type TestDb } from './containers.js';
import { seedTenant } from './support/seed.js';

// S3-BE-07: seed:link-guardians liên kết phụ huynh X/Y với học viên, chặn cứng ngoài môi trường dev.
describe('seed:link-guardians', () => {
  let db: TestDb;
  let worker: pg.Pool;

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
  }, 120_000);
  afterAll(async () => {
    await worker?.end();
    await db?.container.stop();
  });

  it('chặn staging, production và NODE_ENV thiếu; cho local/development/test', () => {
    for (const env of ['staging', 'production', undefined, '', 'prod'])
      expect(() => assertDevEnvironment({ NODE_ENV: env })).toThrow(
        /môi trường dev/,
      );
    for (const env of ['local', 'development', 'test'])
      expect(() => assertDevEnvironment({ NODE_ENV: env })).not.toThrow();
  });

  it('S11: chỉ nhận host local hoặc tên service docker; host khác cần --i-know', () => {
    for (const ok of [
      'postgres://u:p@localhost:5433/db',
      'postgres://u:p@127.0.0.1/db',
      'postgres://u:p@postgres:5432/db',
    ])
      expect(() => assertLocalDatabase(ok)).not.toThrow();
    const rds = 'postgres://u:p@db.abc.ap-southeast-1.rds.amazonaws.com/db';
    expect(() => assertLocalDatabase(rds)).toThrow(/từ chối host/);
    expect(() => assertLocalDatabase(rds, true)).not.toThrow();
  });

  it('ghi guardians.user_id + vai trò parent cho X (cha) và Y (mẹ); chạy lại không tạo trùng', async () => {
    const A = await seedTenant(worker);
    const studentId = randomUUID();
    await worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Em Bé')`,
      [studentId, A.tenantId],
    );
    const opts = {
      studentId,
      parentX: `x-${studentId}@example.com`,
      parentY: `y-${studentId}@example.com`,
    };
    const first = await linkParents(worker, opts);
    const again = await linkParents(worker, opts);
    expect(again).toEqual(first);
    const g = (
      await worker.query(
        `select user_id, relation from guardians where student_id = $1 order by relation`,
        [studentId],
      )
    ).rows;
    expect(g).toEqual([
      { user_id: first.x, relation: 'father' },
      { user_id: first.y, relation: 'mother' },
    ]);
    const m = (
      await worker.query(
        `select m.role, m.tenant_id, u.last_membership_id = m.id as active from memberships m join users u on u.id = m.user_id where u.id = $1`,
        [first.x],
      )
    ).rows;
    expect(m).toEqual([{ role: 'parent', tenant_id: null, active: true }]);
  });

  it('học viên không tồn tại → lỗi, không ghi gì', async () => {
    await expect(
      linkParents(worker, {
        studentId: randomUUID(),
        parentX: 'q@example.com',
        parentY: 'r@example.com',
      }),
    ).rejects.toThrow(/Không có học viên/);
    expect(
      (await worker.query(`select 1 from users where email = 'q@example.com'`))
        .rows,
    ).toHaveLength(0);
  });
});
