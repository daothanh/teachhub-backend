import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { startTestDb, type TestDb } from './containers.js';

describe('api (e2e)', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let app: NestFastifyApplication;

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
    });
    // Import sau khi đặt env: cấu hình được kiểm tra lúc nạp module.
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.container.stop(), redis?.stop()]);
  });

  it('GET /health/ready kiểm tra PostgreSQL và Redis', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { db: true, redis: true },
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
});
