import { generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';

// S1-BE-06: SSO Google bằng id_token giả ký bằng khóa test, JWKS phục vụ từ server cục bộ.
describe('SSO Google: /v1/auth/sso/google', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let worker: pg.Pool;
  let jwks: Server;
  let app: NestFastifyApplication;
  const google = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const idToken = (
    claims: Record<string, unknown> = {},
    opts: { key?: KeyObject; iss?: string; aud?: string; exp?: number } = {},
  ) =>
    new SignJWT({
      email: 'co.lan@gmail.com',
      email_verified: true,
      name: 'Cô Lan',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer(opts.iss ?? 'https://accounts.google.com')
      .setAudience(opts.aud ?? 'android-client')
      .setSubject((claims.sub as string) ?? 'g-sub-1')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '1h')
      .sign(opts.key ?? google.privateKey);
  const sso = (id_token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/sso/google',
      payload: { id_token },
    });

  beforeAll(async () => {
    [db, redis] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const jwk = {
      ...google.publicKey.export({ format: 'jwk' }),
      kid: 'g1',
      alg: 'RS256',
      use: 'sig',
    };
    jwks = createServer((_, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url('teachhub_app'),
      REDIS_URL: redis.getConnectionUrl(),
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
      GOOGLE_CLIENT_IDS: 'android-client, ios-client,web-client',
      GOOGLE_JWKS_URL: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`,
    });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await worker?.end();
    jwks?.close();
    await Promise.all([db?.container.stop(), redis?.stop()]);
  });

  it('lần đầu → tạo user (tên lấy từ Google), chưa vai trò; lần sau → cùng user', async () => {
    const first = await sso(await idToken());
    expect(first.statusCode).toBe(200);
    expect(first.json().user).toMatchObject({
      email: 'co.lan@gmail.com',
      displayName: 'Cô Lan',
      permissions: [],
    });
    const again = await sso(
      await idToken({ email: 'Co.Lan@Gmail.com' }, { aud: 'ios-client' }),
    );
    expect(again.json().user.id).toBe(first.json().user.id);
  });

  it('email đã xác minh trùng user đăng ký bằng OTP → gắn vào user đó, không đè tên', async () => {
    const email = 'thay.nam@gmail.com';
    const otpUser = await app
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
    await worker.query(
      `update users set display_name = 'Thầy Nam' where id = $1`,
      [otpUser],
    );
    const res = await sso(
      await idToken({ sub: 'g-sub-nam', email, name: 'Nam Nguyen' }),
    );
    expect(res.json().user).toMatchObject({
      id: otpUser,
      displayName: 'Thầy Nam',
    });
    const { rows } = await worker.query(
      `select provider from auth_identities where user_id = $1 order by provider`,
      [otpUser],
    );
    expect(rows.map((r) => r.provider)).toEqual(['email', 'google']);
  });

  it('email không phải Gmail/Workspace trùng user có sẵn → không gộp, yêu cầu OTP', async () => {
    const email = 'chu.so@yahoo.com';
    await app
      .get(TxService)
      .run({ userId: null }, (t) =>
        t.execute(
          sql`select app_private.sign_in_identity('email', ${email}, ${email}, ${randomUUID()}, ${randomUUID()})`,
        ),
      );
    const res = await sso(await idToken({ sub: 'g-sub-yahoo', email }));
    expect(res.statusCode).toBe(401);
    expect(res.json().details).toEqual({ reason: 'EMAIL_REQUIRES_OTP' });
    const { rows } = await worker.query(
      `select count(*)::int n from auth_identities where subject = 'g-sub-yahoo'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('Workspace (hd khớp tên miền) được gộp; email ngoài Gmail/Workspace không tạo tài khoản qua Google', async () => {
    const email = 'gv@truong.edu.vn';
    const otpUser = await app
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
    const ws = await sso(
      await idToken({ sub: 'g-sub-ws', email, hd: 'truong.edu.vn' }),
    );
    expect(ws.json().user.id).toBe(otpUser);

    // Chiếm trước: nếu tạo được, chủ thật đăng nhập OTP sau sẽ bị gộp vào tài khoản này.
    const fresh = await sso(
      await idToken({ sub: 'g-sub-new', email: 'moi@outlook.com' }),
    );
    expect(fresh.statusCode).toBe(401);
    expect(fresh.json().details).toEqual({ reason: 'EMAIL_REQUIRES_OTP' });
    const { rows } = await worker.query(
      `select count(*)::int n from users where email = 'moi@outlook.com'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('iss dạng không https vẫn nhận', async () => {
    const res = await sso(
      await idToken({ sub: 'g-sub-2' }, { iss: 'accounts.google.com' }),
    );
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [
      'sai aud (client ID của app khác)',
      () => idToken({}, { aud: 'evil-client' }),
    ],
    ['sai iss', () => idToken({}, { iss: 'https://evil.example.com' })],
    ['hết hạn', () => idToken({}, { exp: Math.floor(Date.now() / 1000) - 60 })],
    [
      'ký bằng khóa khác',
      () =>
        idToken(
          {},
          {
            key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
          },
        ),
    ],
    ['email chưa xác minh', () => idToken({ email_verified: false })],
    ['không có email', () => idToken({ email: undefined })],
    ['chuỗi rác', () => Promise.resolve('abc.def.ghi')],
  ])('%s → 401 UNAUTHENTICATED', async (_, make) => {
    const res = await sso(await make());
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('thiếu id_token → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/sso/google',
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });
});
