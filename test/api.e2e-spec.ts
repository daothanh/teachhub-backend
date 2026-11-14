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
