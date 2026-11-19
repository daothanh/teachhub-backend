import { randomUUID } from 'node:crypto';
import { TxService } from '@teachhub/db';
import { startTestApp, type TestApp } from './support/app.js';
import { expectRowIsolated } from './support/isolation.js';

// S2-BE-11: POST /v1/center-waitlist (US-0.10 AC4). Dữ liệu thuộc user, chưa có tenant.
describe('center-waitlist API', () => {
  let t: TestApp;
  type U = { userId: string; token: string };
  const user = async (): Promise<U> => {
    const userId = randomUUID();
    await t.worker.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    return { userId, token: await t.tokenFor(userId) };
  };
  const post = (u: U, payload: object, key: string | null = randomUUID()) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/center-waitlist',
      payload,
      headers: {
        authorization: `Bearer ${u.token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });
  const body = { centerName: 'Trung tâm Ánh Dương', teacherCount: 8 };
  const countOf = async (userId: string) =>
    (
      await t.worker.query(
        `select count(*)::int n from center_waitlist where user_id = $1`,
        [userId],
      )
    ).rows[0].n as number;

  beforeAll(async () => {
    t = await startTestApp();
  }, 180_000);
  afterAll(() => t?.stop());

  it('tạo bản đăng ký → 201 đúng dạng; gửi lặp cùng Idempotency-Key → phát lại, một bản ghi', async () => {
    const a = await user();
    const key = randomUUID();
    const r1 = await post(a, body, key);
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json()).toMatchObject({ ...body });
    expect(typeof r1.json().createdAt).toBe('string');
    const r2 = await post(a, body, key);
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json()).toEqual(r1.json());
    expect(await countOf(a.userId)).toBe(1);
    // khóa mới = ý định mới
    await post(a, body);
    expect(await countOf(a.userId)).toBe(2);
  });

  it('thiếu khóa idempotency, thiếu tên hoặc số giáo viên sai → 422', async () => {
    const a = await user();
    expect((await post(a, body, null)).statusCode).toBe(422);
    const bad = await post(a, { centerName: ' ', teacherCount: 0 });
    expect(bad.statusCode).toBe(422);
    expect(Object.keys(bad.json().errors)).toEqual([
      'centerName',
      'teacherCount',
    ]);
    expect(await countOf(a.userId)).toBe(0);
  });

  it('user khác dùng cùng Idempotency-Key vẫn tạo bản ghi riêng; RLS chặn đọc/sửa/xóa bản của người khác', async () => {
    const [a, b] = [await user(), await user()];
    const key = randomUUID();
    const ra = await post(a, body, key);
    const rb = await post(b, body, key);
    expect(rb.headers['idempotent-replayed']).toBeUndefined();
    expect(rb.json().id).not.toBe(ra.json().id);
    await expectRowIsolated(t.app.get(TxService), {
      table: 'center_waitlist',
      rowId: ra.json().id,
      owner: a.userId,
      intruder: b.userId,
    });
  });
});
