import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';

// S1-BE-05: refresh token xoay vòng, phát hiện dùng lại, hạn trượt 30 ngày / tối đa 90 ngày, logout, me.
describe('phiên: /v1/auth/refresh, /v1/auth/logout, /v1/auth/me', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let worker: pg.Pool;
  let app: NestFastifyApplication;
  let redisClient: Redis;
  let session: typeof import('../libs/modules/auth/session/session.service.js');

  type Tokens = { access_token: string; refresh_token: string };

  /** User mới + một phiên, như sau khi đăng nhập OTP. */
  const login = async (): Promise<Tokens & { userId: string }> => {
    const email = `${randomUUID()}@example.com`;
    const userId = await app
      .get(TxService)
      .run(
        { userId: null },
        async (t) =>
          (
            await t.execute<{ id: string }>(
              sql`select app_private.sign_in_identity('email', ${email}, ${email}, ${randomUUID()}, ${randomUUID()}) as id`,
            )
          ).rows[0]!.id,
      );
    const { SessionService } =
      await import('../libs/modules/auth/session/session.service.js');
    return { userId, ...(await app.get(SessionService).open(userId)) };
  };
  const refresh = (refresh_token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token },
    });
  const withToken = (method: 'GET' | 'POST', url: string, token: string) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
  const family = async (token: string) =>
    (
      await worker.query(
        `select family_id from refresh_tokens where token_hash = encode(sha256($1::bytea), 'hex')`,
        [token],
      )
    ).rows[0]?.family_id as string;

  beforeAll(async () => {
    [db, redis] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url('teachhub_app'),
      REDIS_URL: redis.getConnectionUrl(),
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
    });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // Import động: nạp sớm hơn sẽ đọc biến môi trường trước khi container sẵn sàng.
    session = await import('../libs/modules/auth/session/session.service.js');
    redisClient = app.get<Redis>((await import('@teachhub/infra')).REDIS);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await worker?.end();
    await Promise.all([db?.container.stop(), redis?.stop()]);
  });

  it('làm mới: cặp token mới, token cũ bị thu hồi, hạn trượt 30 ngày', async () => {
    const s = await login();
    const res = await refresh(s.refresh_token);
    expect(res.statusCode).toBe(200);
    const next = res.json() as Tokens & { expires_in: number };
    expect(next.expires_in).toBe(900);
    expect(next.refresh_token).not.toBe(s.refresh_token);

    const { rows } = await worker.query(
      `select token_hash = encode(sha256($1::bytea), 'hex') as is_old, revoked_at is not null as revoked,
              replaced_by is not null as replaced, expires_at - now() as ttl
         from refresh_tokens where family_id = $2 order by created_at, revoked_at nulls last`,
      [s.refresh_token, await family(s.refresh_token)],
    );
    expect(rows.map((r) => [r.is_old, r.revoked, r.replaced])).toEqual([
      [true, true, true],
      [false, false, false],
    ]);
    expect(rows[1].ttl.days).toBeGreaterThanOrEqual(29);

    const me = await withToken('GET', '/v1/auth/me', next.access_token);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: s.userId, permissions: [] });
  });

  it('gửi lại token vừa xoay trong khoảng ân hạn (phản hồi bị rớt) → 200 cùng refresh token, họ không bị thu hồi', async () => {
    const s = await login();
    const next = (await refresh(s.refresh_token)).json() as Tokens;
    const again = await refresh(s.refresh_token);
    expect(again.statusCode).toBe(200);
    expect(again.json().refresh_token).toBe(next.refresh_token);
    const me = await withToken('GET', '/v1/auth/me', again.json().access_token);
    expect(me.statusCode).toBe(200);
    // Token đã trả vẫn dùng tiếp được: họ còn sống.
    expect((await refresh(next.refresh_token)).statusCode).toBe(200);
  });

  it('khóa ân hạn chỉ đổi được một lần: lần gửi lại thứ hai → 401, thu hồi cả họ', async () => {
    const s = await login();
    const next = (await refresh(s.refresh_token)).json() as Tokens;
    expect((await refresh(s.refresh_token)).statusCode).toBe(200);
    expect((await refresh(s.refresh_token)).statusCode).toBe(401);
    expect((await refresh(next.refresh_token)).statusCode).toBe(401);
  });

  it('ân hạn không cứu token đã xoay tiếp hoặc phiên đã đăng xuất', async () => {
    const s = await login();
    const next = (await refresh(s.refresh_token)).json() as Tokens;
    await refresh(next.refresh_token);
    // next đã bị xoay → lần gửi lại token gốc rơi về đường dùng lại, thu hồi cả họ.
    expect((await refresh(s.refresh_token)).statusCode).toBe(401);

    const b = await login();
    const bNext = (await refresh(b.refresh_token)).json() as Tokens;
    await withToken('POST', '/v1/auth/logout', bNext.access_token);
    expect((await refresh(b.refresh_token)).statusCode).toBe(401);
  });

  it('dùng lại token đã xoay ngoài khoảng ân hạn → 401 và thu hồi cả họ (token mới cũng chết)', async () => {
    const s = await login();
    const next = (await refresh(s.refresh_token)).json() as Tokens;
    // Hết REFRESH_GRACE_SEC: khóa ân hạn trong Redis đã hết TTL.
    await redisClient.del(session.refreshGraceKey(s.refresh_token));
    const reuse = await refresh(s.refresh_token);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('UNAUTHENTICATED');
    expect((await refresh(next.refresh_token)).statusCode).toBe(401);
    const { rows } = await worker.query(
      `select count(*)::int as live from refresh_tokens where family_id = $1 and revoked_at is null`,
      [await family(s.refresh_token)],
    );
    expect(rows[0].live).toBe(0);
  });

  it('khóa ân hạn có TTL bằng REFRESH_GRACE_SEC và không chứa token thô', async () => {
    const s = await login();
    const next = (await refresh(s.refresh_token)).json() as Tokens;
    const key = session.refreshGraceKey(s.refresh_token);
    const ttl = await redisClient.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(session.REFRESH_GRACE_SEC);
    expect(await redisClient.get(key)).not.toContain(next.refresh_token);
  });

  it('hai lần làm mới cùng token đồng thời: không bao giờ ra hai token sống', async () => {
    const s = await login();
    const res = await Promise.all([
      refresh(s.refresh_token),
      refresh(s.refresh_token),
    ]);
    // Lần thứ hai hoặc trúng ân hạn (cùng token), hoặc bị coi là dùng lại (401, thu hồi họ).
    const ok = res.filter((r) => r.statusCode === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.json().refresh_token)).size).toBe(1);
    const { rows } = await worker.query(
      `select count(*)::int as live from refresh_tokens where family_id = $1 and revoked_at is null`,
      [await family(s.refresh_token)],
    );
    expect(rows[0].live).toBeLessThanOrEqual(1);
  });

  it('tối đa 90 ngày kể từ lần đăng nhập, kể cả khi vẫn làm mới đều', async () => {
    const s = await login();
    const fam = await family(s.refresh_token);
    await worker.query(
      `update refresh_tokens set created_at = now() - interval '89 days' where family_id = $1`,
      [fam],
    );
    const near = await refresh(s.refresh_token);
    expect(near.statusCode).toBe(200);
    const { rows } = await worker.query(
      `select expires_at <= now() + interval '1 day' as capped from refresh_tokens
        where token_hash = encode(sha256($1::bytea), 'hex')`,
      [near.json().refresh_token],
    );
    expect(rows[0].capped).toBe(true);

    await worker.query(
      `update refresh_tokens set created_at = now() - interval '91 days' where family_id = $1`,
      [fam],
    );
    expect((await refresh(near.json().refresh_token)).statusCode).toBe(401);
  });

  it('refresh token hết hạn hoặc không tồn tại → 401; thiếu trường → 422', async () => {
    const s = await login();
    await worker.query(
      `update refresh_tokens set expires_at = now() - interval '1 second'
        where token_hash = encode(sha256($1::bytea), 'hex')`,
      [s.refresh_token],
    );
    expect((await refresh(s.refresh_token)).statusCode).toBe(401);
    expect((await refresh('khong-ton-tai')).json().code).toBe(
      'UNAUTHENTICATED',
    );
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
    });
    expect(bad.statusCode).toBe(422);
  });

  it('logout thu hồi phiên hiện tại, không đụng phiên khác của cùng user', async () => {
    const a = await login();
    const { SessionService } =
      await import('../libs/modules/auth/session/session.service.js');
    const other = await app.get(SessionService).open(a.userId);

    const out = await withToken('POST', '/v1/auth/logout', a.access_token);
    expect(out.statusCode).toBe(204);
    expect((await refresh(a.refresh_token)).statusCode).toBe(401);
    expect((await refresh(other.refresh_token)).statusCode).toBe(200);
  });

  it('me / logout cần access token', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/logout' })).statusCode,
    ).toBe(401);
  });

  it('me trả quyền theo vai trò đang hoạt động', async () => {
    const s = await login();
    await worker.query(
      `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
      [randomUUID(), s.userId],
    );
    const me = await withToken('GET', '/v1/auth/me', s.access_token);
    expect(me.json().permissions).toEqual(['role:parent']);
  });
});
