import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';

// S4-BE-05: POST /consents giới hạn 10 request/phút. Cần giới hạn thật nên đặt RATE_LIMIT_SCALE=1 (xem throttle.e2e-spec).
describe('consents: giới hạn tần suất', () => {
  let t: TestApp;

  beforeAll(async () => {
    process.env.RATE_LIMIT_SCALE = '1';
    t = await startTestApp();
  }, 180_000);
  afterAll(async () => {
    await t?.stop();
  });

  it('11 request khác nhau trong một phút: 10 lần đầu qua guard (409 sai phiên bản), lần 11 trả 429', async () => {
    const userId = randomUUID();
    await t.worker.query(
      `insert into users (id, email, display_name) values ($1, $2, 'PH')`,
      [userId, `${userId}@example.com`],
    );
    const token = await t.tokenFor(userId);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/v1/consents',
        payload: {
          role: 'parent',
          termsVersion: `1999-01-${String(i + 1).padStart(2, '0')}`,
        },
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': randomUUID(),
        },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 409)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
