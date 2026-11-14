import pg from 'pg';
import { startTestDb, type TestDb } from './containers.js';
import { tablesMissingRls } from './support/isolation.js';
import { drizzle } from 'drizzle-orm/node-postgres';

// R1 (§4.5): sau khi chạy toàn bộ migration trên CSDL trống, không bảng nào trong `public` thiếu
// `enable` + `force row level security`. Fail → PR đỏ (job CI "kiểm RLS").
describe('kiểm RLS toàn bộ migration', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.container.stop();
  });

  const missing = async () => {
    const pool = new pg.Pool({ connectionString: db.url('teachhub_owner') });
    const { rows } = await drizzle(pool).execute(tablesMissingRls);
    await pool.end();
    return rows.map((r) => r.table);
  };

  it('mọi bảng public đều bật và ép RLS', async () => {
    expect(await missing()).toEqual([]);
  });

  // Chạy sau ca trên: chứng minh truy vấn kiểm bắt được bảng chỉ enable mà quên force.
  it('bắt được bảng thiếu force row level security', async () => {
    const owner = new pg.Client({ connectionString: db.url('teachhub_owner') });
    await owner.connect();
    await owner.query(
      'create table rls_forgotten (id uuid); alter table rls_forgotten enable row level security',
    );
    await owner.end();
    expect(await missing()).toEqual(['rls_forgotten']);
  });
});
