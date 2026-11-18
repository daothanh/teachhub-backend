import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { startTestDb, type TestDb } from './containers.js';

// S1-BE-04: email OTP — US-0.1 AC1 (email mới = đăng ký, chưa có vai trò), AC3 (khóa 15 phút, hết hạn 5 phút).
describe('email OTP: /v1/auth/otp/send, /v1/auth/login', () => {
  let db: TestDb;
  let redisC: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let redis: Redis;
  let worker: pg.Pool;
  let app: NestFastifyApplication;

  const keyOf = (kind: string, email: string) =>
    `otp:${kind}:${createHash('sha256').update(email).digest('hex')}`;
  const mailApi = () =>
    `http://127.0.0.1:${mailpit.getMappedPort(8025)}/api/v1`;

  const send = (email: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/otp/send',
      payload: { email },
    });
  const login = (email: string, code: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { method: 'email_otp', email, code },
    });

  /** Mã trong email mới nhất gửi tới `email` (tiêu đề "<mã> là mã đăng nhập…"). */
  const lastCode = async (email: string): Promise<string> => {
    const res = await fetch(`${mailApi()}/messages`);
    const { messages } = (await res.json()) as {
      messages: { To: { Address: string }[]; Subject: string }[];
    };
    const msg = messages.find((m) => m.To[0]?.Address === email);
    const code = msg?.Subject.match(/^(\d{6}) /)?.[1];
    if (!code) throw new Error(`không thấy email OTP cho ${email}`);
    return code;
  };
  const wrong = (code: string) =>
    ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

  beforeAll(async () => {
    [db, redisC, mailpit] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
      new GenericContainer('axllent/mailpit:v1.33.1')
        .withExposedPorts(1025, 8025)
        .start(),
    ]);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url('teachhub_app'),
      REDIS_URL: redisC.getConnectionUrl(),
      // 127.0.0.1: `localhost` có thể ra IPv6 mà cổng chỉ mở ở IPv4.
      SMTP_URL: `smtp://127.0.0.1:${mailpit.getMappedPort(1025)}`,
      // Kho S3 không dùng ở đây; client chỉ được dựng, không gọi.
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
    });
    redis = new Redis(redisC.getConnectionUrl());
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await worker?.end();
    await Promise.all([db?.container.stop(), redisC?.stop(), mailpit?.stop()]);
  });

  it('AC1: email mới → gửi mã → đăng nhập = đăng ký; chưa vai trò, không tenant', async () => {
    const email = 'co.lan@example.com';
    expect((await send(email)).statusCode).toBe(204);
    const code = await lastCode(email);
    // Mã sống 5 phút; Redis không chứa email thô.
    expect(await redis.ttl(keyOf('code', email))).toBeGreaterThan(290);
    expect((await redis.keys('*')).some((k) => k.includes(email))).toBe(false);

    const res = await login(email, code);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      expires_in: 900,
      user: { email, displayName: null, permissions: [] },
    });
    expect(body.refresh_token).toMatch(/^[\w-]{43}$/);

    const { rows } = await worker.query(
      `select (select count(*)::int from users where email = $1) users,
              (select count(*)::int from auth_identities where provider = 'email' and subject = $1) identities,
              (select count(*)::int from memberships) memberships,
              (select count(*)::int from tenants) tenants,
              (select count(*)::int from refresh_tokens where token_hash = encode(sha256($2::bytea), 'hex')) sessions`,
      [email, body.refresh_token],
    );
    expect(rows[0]).toEqual({
      users: 1,
      identities: 1,
      memberships: 0,
      tenants: 0,
      sessions: 1,
    });

    // Access token qua được guard.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(me.statusCode).not.toBe(401);

    // Mã dùng một lần.
    expect((await login(email, code)).json().code).toBe('OTP_INVALID');
  });

  it('đăng nhập lại (chữ hoa/thường khác) vào đúng user cũ, không tạo user mới', async () => {
    const email = 'thay.nam@example.com';
    await send(email);
    const first = (await login(email, await lastCode(email))).json();
    await redis.del(keyOf('cooldown', email));
    await send('Thay.Nam@Example.com');
    const again = (
      await login('THAY.NAM@example.com', await lastCode(email))
    ).json();
    expect(again.user.id).toBe(first.user.id);
    const { rows } = await worker.query(
      `select count(*)::int n from users where email = $1`,
      [email],
    );
    expect(rows[0].n).toBe(1);
  });

  it('gửi lại trong 60 giây → 429 RATE_LIMITED + Retry-After', async () => {
    const email = 'nhanh@example.com';
    expect((await send(email)).statusCode).toBe(204);
    const res = await send(email);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
    const retry = res.json().details.retryAfterSec;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(res.headers['retry-after']).toBe(String(retry));
  });

  it('quá 5 lần/giờ → 429 RATE_LIMITED', async () => {
    const email = 'nhieu@example.com';
    for (let i = 0; i < 5; i++) {
      expect((await send(email)).statusCode).toBe(204);
      await redis.del(keyOf('cooldown', email)); // bỏ qua chờ 60 giây
    }
    const res = await send(email);
    expect(res.statusCode).toBe(429);
    expect(res.json().details.retryAfterSec).toBeGreaterThan(60);
  });

  it('AC3: sai 5 lần → khóa 15 phút; đúng mã trong lúc khóa vẫn bị chặn', async () => {
    const email = 'sai.ma@example.com';
    await send(email);
    const code = await lastCode(email);
    for (let i = 0; i < 4; i++) {
      const res = await login(email, wrong(code));
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('OTP_INVALID');
    }
    const fifth = await login(email, wrong(code));
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({
      code: 'OTP_LOCKED',
      details: { retryAfterSec: 900 },
    });
    expect(fifth.headers['retry-after']).toBe('900');

    const during = await login(email, code);
    expect(during.json().code).toBe('OTP_LOCKED');
    expect(during.json().details.retryAfterSec).toBeLessThanOrEqual(900);

    // Đang khóa thì không cấp mã mới.
    await redis.del(keyOf('cooldown', email));
    const resend = await send(email);
    expect(resend.statusCode).toBe(429);
    expect(resend.json().details.retryAfterSec).toBeGreaterThan(800);
  });

  it('đoán mã song song không vượt được giới hạn 5 lần', async () => {
    const email = 'song.song@example.com';
    await send(email);
    const code = await lastCode(email);
    const res = await Promise.all(
      Array.from({ length: 30 }, () => login(email, wrong(code))),
    );
    const codes = res.map((r) => r.json().code);
    // Chỉ lượt 1–4 được báo sai mã; lượt 5 trở đi khóa.
    expect(codes.filter((c) => c === 'OTP_INVALID').length).toBe(4);
    expect(codes.filter((c) => c === 'OTP_LOCKED').length).toBe(26);
    expect((await login(email, code)).json().code).toBe('OTP_LOCKED');
  });

  it('không có mã thì nhập sai không đếm: người lạ không khóa được email người khác', async () => {
    const email = 'nan.nhan@example.com';
    for (let i = 0; i < 10; i++) {
      expect((await login(email, '000000')).json().code).toBe('OTP_INVALID');
    }
    await send(email);
    expect((await login(email, await lastCode(email))).statusCode).toBe(200);
  });

  it('AC3: mã hết hạn → OTP_INVALID', async () => {
    const email = 'het.han@example.com';
    await send(email);
    const code = await lastCode(email);
    await redis.del(keyOf('code', email)); // như hết TTL 5 phút
    expect((await login(email, code)).json().code).toBe('OTP_INVALID');
  });

  it('mã không đủ 6 số → 422', async () => {
    const res = await login('a@example.com', '123');
    expect(res.statusCode).toBe(422);
  });
});
