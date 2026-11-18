import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import {
  startTestDb,
  startTestS3,
  type TestDb,
  type TestS3,
} from './containers.js';

describe('api (e2e)', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let s3: TestS3;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    [db, redis, s3] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
      startTestS3(),
    ]);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url('teachhub_app'),
      REDIS_URL: redis.getConnectionUrl(),
      ...s3.env,
    });
    // Import sau khi đặt env: cấu hình được kiểm tra lúc nạp module.
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([
      db?.container.stop(),
      redis?.stop(),
      s3?.container.stop(),
    ]);
  });

  it('S1-BE-03: route mặc định cần access token; JWKS công khai', async () => {
    const jwks = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.json().keys[0]).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
    });
    expect(jwks.json().keys[0]).not.toHaveProperty('d');

    const none = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json().code).toBe('UNAUTHENTICATED');
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(bad.json().code).toBe('UNAUTHENTICATED');

    const { JwtKeysService } = await import('@teachhub/modules/auth');
    const token = await app.get(JwtKeysService).sign({
      userId: '019a8f3e-7c1b-7d2a-9b3e-5f6a7b8c9d0e',
      sessionId: 's-1',
      membershipsVersion: 0,
    });
    // Qua guard → tới handler.
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/me/memberships',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('GET /health/ready kiểm tra PostgreSQL, Redis và kho S3', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { db: true, redis: true, s3: true },
    });
  });

  it('route không tồn tại → 404 đúng định dạng lỗi chuẩn, trả lại x-request-id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/khong-co',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'Không tìm thấy.',
      requestId: 'abc-123',
    });
  });

  it('GET /v1/app-config công khai, trả phiên bản tối thiểu theo nền tảng', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/app-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      minSupportedVersion: {
        android: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        ios: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      },
    });
  });

  it('body sai hợp đồng → 422 kèm lỗi theo trường', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { method: 'email_otp', email: 'khong-phai-email', code: '12' },
    });
    expect(bad.statusCode).toBe(422);
    expect(Object.keys(bad.json().errors).sort()).toEqual(['code', 'email']);
  });

  it('health nằm ngoài tiền tố /v1', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/health/live' })).statusCode,
    ).toBe(404);
  });

  // Chạy cuối: dừng MinIO thật.
  it('kho S3 không truy cập được → 503, chỉ rõ phụ thuộc lỗi', async () => {
    await s3.container.stop();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { db: true, redis: true, s3: false },
    });
  });
});
