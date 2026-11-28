import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from 'node:crypto';
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

// S2-BE-01: SSO Apple bằng identityToken giả ký bằng khóa test, JWKS phục vụ từ server cục bộ.
describe('SSO Apple: /v1/auth/sso/apple', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let worker: pg.Pool;
  let jwks: Server;
  let app: NestFastifyApplication;
  const apple = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  /** Mỗi token một `jti` ngẫu nhiên: các test không đụng chống phát lại của nhau. */
  const identityToken = (
    nonce: string,
    claims: Record<string, unknown> = {},
    opts: {
      key?: KeyObject;
      iss?: string;
      aud?: string;
      exp?: number | string;
    } = {},
  ) =>
    new SignJWT({
      email: 'co.lan@gmail.com',
      email_verified: 'true',
      nonce: sha(nonce),
      jti: randomUUID(),
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'a1' })
      .setIssuer(opts.iss ?? 'https://appleid.apple.com')
      .setAudience(opts.aud ?? 'vn.dayhoc.test')
      .setSubject((claims.sub as string) ?? 'a-sub-1')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '1h')
      .sign(opts.key ?? apple.privateKey);
  const sso = (id_token: string, nonce = 'n-raw', extra: object = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/sso/apple',
      payload: { id_token, nonce, ...extra },
    });
  const signInOtp = (email: string) =>
    app
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

  beforeAll(async () => {
    [db, redis] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const jwk = {
      ...apple.publicKey.export({ format: 'jwk' }),
      kid: 'a1',
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
      // Cố ý thêm Services ID vào cấu hình native để kiểm route native vẫn từ chối.
      APPLE_BUNDLE_ID: 'vn.dayhoc.test,vn.dayhoc.app.web',
      APPLE_ANDROID_ENABLED: 'true',
      APPLE_JWKS_URL: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/keys`,
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

  const androidPath = '/v1/auth/sso/apple/android';
  const s256 = (value: string) =>
    createHash('sha256').update(value).digest('base64url');
  const startAndroid = (code_challenge: string) =>
    app.inject({
      method: 'POST',
      url: `${androidPath}/start`,
      payload: { code_challenge },
    });
  const beginAndroid = async () => {
    const verifier = randomBytes(32).toString('base64url');
    const res = await startAndroid(s256(verifier));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ authorization_url: string; expires_in: number }>();
    const url = new URL(body.authorization_url);
    return {
      verifier,
      url,
      expiresIn: body.expires_in,
      state: url.searchParams.get('state')!,
      nonce: url.searchParams.get('nonce')!,
    };
  };
  const appleCode = 'apple-code-for-test';
  const androidToken = (
    nonce: string,
    claims: Record<string, unknown> = {},
    aud = 'vn.dayhoc.app.web',
  ) =>
    identityToken('n-raw', {
      nonce,
      c_hash: createHash('sha256')
        .update(appleCode)
        .digest()
        .subarray(0, 16)
        .toString('base64url'),
      ...claims,
    }, { aud });
  const callbackAndroid = (payload: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `${androidPath}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      payload: new URLSearchParams(payload).toString(),
    });
  const redeemAndroid = (code: string, code_verifier: string) =>
    app.inject({
      method: 'POST',
      url: `${androidPath}/redeem`,
      payload: { code, code_verifier },
    });
  const appCode = (location: unknown) => {
    expect(location).toMatch(/^dayhoc:\/\/auth\/apple\/callback\?code=[A-Za-z0-9_-]{43}$/);
    return new URL(location as string).searchParams.get('code')!;
  };

  it('Android: start kiểm S256 và tạo URL Apple với state và nonce riêng', async () => {
    expect((await startAndroid('plain-verifier')).statusCode).toBe(422);
    const a = await beginAndroid();
    const b = await beginAndroid();
    expect(a.expiresIn).toBe(300);
    expect(a.url.origin + a.url.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(Object.fromEntries(a.url.searchParams)).toMatchObject({
      client_id: 'vn.dayhoc.app.web',
      redirect_uri: 'https://app.dayhoc.app/auth/apple/callback',
      response_type: 'code id_token',
      response_mode: 'form_post',
      scope: 'name email',
    });
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([a.state, a.nonce, b.state, b.nonce]).size).toBe(4);
    expect(a.url.searchParams.has('code_challenge')).toBe(false);
  });

  it('Android: callback từ chối sai media type, state, audience, nonce và c_hash', async () => {
    const { state, nonce } = await beginAndroid();
    const good = await androidToken(nonce);
    const wrongMedia = await app.inject({
      method: 'POST',
      url: `${androidPath}/callback`,
      payload: { state, code: appleCode, id_token: good },
    });
    expect(wrongMedia.statusCode).toBe(415);
    expect(wrongMedia.headers.location).toBeUndefined();
    const unknown = await callbackAndroid({
      state: randomBytes(32).toString('base64url'),
      error: 'user_cancelled_authorize',
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.headers.location).toBeUndefined();
    for (const id_token of [
      await androidToken(nonce, {}, 'vn.dayhoc.test'),
      await androidToken('wrong-nonce'),
      await androidToken(nonce, { c_hash: 'wrong-hash' }),
    ]) {
      const res = await callbackAndroid({ state, code: appleCode, id_token });
      expect(res.statusCode).toBe(401);
      expect(res.headers.location).toBeUndefined();
    }
    expect((await sso(await androidToken(sha('n-raw')))).statusCode).toBe(401);
    expect((await callbackAndroid({ state, code: appleCode, id_token: good })).statusCode).toBe(303);
  });

  it('Android: verifier sai không đốt mã, đổi đồng thời chỉ mở một phiên', async () => {
    const { state, nonce, verifier } = await beginAndroid();
    const email = 'android-verified@example.com';
    const id_token = await androidToken(nonce, { sub: 'android-ok', email });
    const form = {
      state,
      code: appleCode,
      id_token,
      user: JSON.stringify({
        name: { firstName: '\u202eCô\n', lastName: ' Lan! ' },
        email: 'ignored@example.com',
      }),
    };
    const callbacks = await Promise.all([callbackAndroid(form), callbackAndroid(form)]);
    expect(callbacks.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([303, 401]);
    const success = callbacks.find((r) => r.statusCode === 303)!;
    expect(success.body).toBe('');
    expect(success.headers['cache-control']).toBe('no-store');
    expect(success.headers['referrer-policy']).toBe('no-referrer');
    const code = appCode(success.headers.location);
    expect((await redeemAndroid(code, 'a'.repeat(43))).statusCode).toBe(401);
    const results = await Promise.all([redeemAndroid(code, verifier), redeemAndroid(code, verifier)]);
    expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([200, 401]);
    expect(results.find((r) => r.statusCode === 200)?.json()).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      user: { email, displayName: 'Cô Lan' },
    });
  });

  it('Android: kết quả hủy cần đúng verifier, chỉ dùng được một lần và không có token', async () => {
    const { state, verifier } = await beginAndroid();
    const payload = { state, error: 'user_cancelled_authorize' };
    const res = await callbackAndroid(payload);
    expect(res.statusCode).toBe(303);
    const code = appCode(res.headers.location);
    expect((await callbackAndroid(payload)).statusCode).toBe(401);
    expect((await redeemAndroid(code, 'b'.repeat(43))).statusCode).toBe(401);
    const cancelled = await redeemAndroid(code, verifier);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ status: 'cancelled' });
    expect((await redeemAndroid(code, verifier)).statusCode).toBe(401);
  });

  it('Android: email relay chưa xác minh và email trong form không được dùng để gộp hay tạo user', async () => {
    const { state, nonce, verifier } = await beginAndroid();
    const email = 'android-unverified@privaterelay.appleid.com';
    await signInOtp(email);
    const id_token = await androidToken(nonce, {
      sub: 'android-unverified',
      email,
      email_verified: false,
    });
    const callback = await callbackAndroid({
      state,
      id_token,
      code: appleCode,
      user: JSON.stringify({ email: 'ignored@example.com' }),
    });
    expect(callback.statusCode).toBe(303);
    const code = appCode(callback.headers.location);
    const redeem = await redeemAndroid(code, verifier);
    expect(redeem.statusCode).toBe(401);
    expect(redeem.json().details).toEqual({ reason: 'EMAIL_REQUIRES_OTP' });
    expect((await redeemAndroid(code, verifier)).json().details).toBeUndefined();
  });

  it('lần đầu → tạo user, tên fullName; lần sau → cùng user, fullName không đè', async () => {
    const first = await sso(await identityToken('n-raw'), 'n-raw', {
      fullName: 'Cô Lan',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().user).toMatchObject({
      email: 'co.lan@gmail.com',
      displayName: 'Cô Lan',
      permissions: [],
    });
    const again = await sso(await identityToken('n2'), 'n2', {
      fullName: 'Tên Khác',
    });
    expect(again.json().user).toMatchObject({
      id: first.json().user.id,
      displayName: 'Cô Lan',
    });
  });

  it('khóa theo sub: đổi email trong token vẫn ra cùng user', async () => {
    const a = await sso(await identityToken('n3', { sub: 'a-sub-sub' }), 'n3');
    const b = await sso(
      await identityToken('n4', { sub: 'a-sub-sub', email: 'doi@gmail.com' }),
      'n4',
    );
    expect(b.json().user.id).toBe(a.json().user.id);
  });

  it('email đã xác minh trùng user OTP → gộp, fullName không đè/gán cho user có sẵn', async () => {
    const email = 'thay.nam@example.com';
    const otpUser = await signInOtp(email);
    // User OTP chưa có tên và vừa tạo: vẫn không nhận fullName từ Apple khi chỉ gộp.
    await worker.query(
      `update users set created_at = now() - interval '1 day' where id = $1`,
      [otpUser],
    );
    const res = await sso(
      await identityToken('n5', { sub: 'a-sub-nam', email }),
      'n5',
      { fullName: 'Nam Nguyen' },
    );
    expect(res.json().user).toMatchObject({ id: otpUser, displayName: null });
    const { rows } = await worker.query(
      `select provider from auth_identities where user_id = $1 order by provider`,
      [otpUser],
    );
    expect(rows.map((r) => r.provider)).toEqual(['apple', 'email']);
  });

  it('email_verified = true (boolean) cũng được gộp', async () => {
    const email = 'boolean@example.com';
    const otpUser = await signInOtp(email);
    const res = await sso(
      await identityToken('n6', {
        sub: 'a-sub-bool',
        email,
        email_verified: true,
      }),
      'n6',
    );
    expect(res.json().user.id).toBe(otpUser);
  });

  it('email chưa xác minh trùng user có sẵn → không gộp, không tạo, yêu cầu OTP', async () => {
    const email = 'chua.xm@example.com';
    await signInOtp(email);
    const res = await sso(
      await identityToken('n7', {
        sub: 'a-sub-unv',
        email,
        email_verified: 'false',
      }),
      'n7',
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().details).toEqual({ reason: 'EMAIL_REQUIRES_OTP' });
    const { rows } = await worker.query(
      `select count(*)::int n from auth_identities where subject = 'a-sub-unv'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('địa chỉ relay → tạo user mới với địa chỉ relay, không gộp vào user nào theo email thật', async () => {
    const realUser = await signInOtp('that@example.com');
    const res = await sso(
      await identityToken('n8', {
        sub: 'a-sub-relay',
        email: 'abc123@privaterelay.appleid.com',
        is_private_email: 'true',
      }),
      'n8',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).not.toBe(realUser);
    expect(res.json().user.email).toBe('abc123@privaterelay.appleid.com');
  });

  it('chống phát lại: cùng token lần hai → 401 TOKEN_REPLAYED', async () => {
    const token = await identityToken('n9', { sub: 'a-sub-replay' });
    expect((await sso(token, 'n9')).statusCode).toBe(200);
    const again = await sso(token, 'n9');
    expect(again.statusCode).toBe(401);
    expect(again.json().details).toEqual({ reason: 'TOKEN_REPLAYED' });
  });

  it('token bị từ chối (sai nonce…) không tiêu khóa phát lại', async () => {
    const token = await identityToken('n10', { sub: 'a-sub-retry' });
    expect((await sso(token, 'nonce-khac')).statusCode).toBe(401);
    expect((await sso(token, 'n10')).statusCode).toBe(200);
  });

  it('hai request song song cùng token → đúng một 200', async () => {
    const token = await identityToken('n11', { sub: 'a-sub-par' });
    const codes = (await Promise.all([sso(token, 'n11'), sso(token, 'n11')]))
      .map((r) => r.statusCode)
      .sort((a, b) => a - b);
    expect(codes).toEqual([200, 401]);
  });

  it('lỗi sau xác minh (yêu cầu OTP) → nhả khóa: gửi lại cùng token nhận lại đúng lỗi đó, không phải TOKEN_REPLAYED', async () => {
    const email = 'chua.xm2@example.com';
    await signInOtp(email);
    const token = await identityToken('n12', {
      sub: 'a-sub-rel',
      email,
      email_verified: 'false',
    });
    for (let i = 0; i < 2; i++) {
      const res = await sso(token, 'n12');
      expect(res.json().details).toEqual({ reason: 'EMAIL_REQUIRES_OTP' });
    }
  });

  it('Redis lỗi khi kiểm chống phát lại → 503', async () => {
    const { REDIS } = await import('@teachhub/infra');
    const spy = vi
      .spyOn(app.get(REDIS), 'set')
      .mockRejectedValueOnce(new Error('redis down'));
    const res = await sso(await identityToken('n13'), 'n13');
    spy.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
  });

  it('user đã có đúng địa chỉ relay → được gắn lại (shortcut đã ghi)', async () => {
    const relay = 'xyz789@privaterelay.appleid.com';
    const existing = await signInOtp(relay);
    const res = await sso(
      await identityToken('n14', { sub: 'a-sub-relay2', email: relay }),
      'n14',
    );
    expect(res.json().user.id).toBe(existing);
  });

  const unsigned = (claims: object) =>
    [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url'),
      '',
    ].join('.');

  it.each([
    [
      'sai aud (bundle ID app khác)',
      () => identityToken('n-raw', {}, { aud: 'evil.app' }),
    ],
    [
      'sai iss',
      () => identityToken('n-raw', {}, { iss: 'https://evil.example.com' }),
    ],
    [
      'hết hạn',
      () =>
        identityToken('n-raw', {}, { exp: Math.floor(Date.now() / 1000) - 60 }),
    ],
    ['sai nonce', () => identityToken('nonce-khac')],
    ['thiếu claim nonce', () => identityToken('n-raw', { nonce: undefined })],
    [
      'nonce trong claim là nonce thô (chưa băm)',
      () => identityToken('n-raw', { nonce: 'n-raw' }),
    ],
    [
      'alg none',
      () =>
        Promise.resolve(
          unsigned({
            iss: 'https://appleid.apple.com',
            aud: 'vn.dayhoc.test',
            sub: 'a-sub-none',
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: sha('n-raw'),
          }),
        ),
    ],
    [
      'alg HS256 (nhầm khóa công khai thành bí mật)',
      async () =>
        new SignJWT({ nonce: sha('n-raw') })
          .setProtectedHeader({ alg: 'HS256', kid: 'a1' })
          .setIssuer('https://appleid.apple.com')
          .setAudience('vn.dayhoc.test')
          .setSubject('a-sub-hs')
          .setExpirationTime('1h')
          .sign(new TextEncoder().encode('x'.repeat(32))),
    ],
    [
      'ký bằng khóa khác',
      () =>
        identityToken(
          'n-raw',
          {},
          {
            key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
          },
        ),
    ],
    ['chuỗi rác', () => Promise.resolve('abc.def.ghi')],
  ])('%s → 401 UNAUTHENTICATED', async (_, make) => {
    const res = await sso(await make());
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('thiếu nonce → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/sso/apple',
      payload: { id_token: 'x' },
    });
    expect(res.statusCode).toBe(422);
  });
});
