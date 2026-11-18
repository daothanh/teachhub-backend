import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { startTestDb, type TestDb } from './containers.js';

// S1-BE-09: giới hạn tần suất theo IP, đếm trong Redis.
describe('giới hạn tần suất theo IP (@nestjs/throttler + Redis)', () => {
  let db: TestDb;
  let redisC: StartedRedisContainer;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    [db, redisC] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url('teachhub_app'),
      REDIS_URL: redisC.getConnectionUrl(),
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
      // SMTP không tồn tại: gửi mã lỗi 500, nhưng throttler chạy trước handler nên vẫn đếm đúng.
      SMTP_URL: 'smtp://127.0.0.1:1',
      RATE_LIMIT_SCALE: '1', // giới hạn thật (vitest.config.e2e.ts đặt 1000 cho test khác)
    });
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.container.stop(), redisC?.stop()]);
  });

  const refresh = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token: 'x' },
      remoteAddress: ip,
    });

  it('refresh: quá 60 request/phút/IP → 429 RATE_LIMITED + Retry-After; IP khác không bị ảnh hưởng', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await refresh('10.0.0.1')).statusCode).toBe(401);
    }
    const blocked = await refresh('10.0.0.1');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('RATE_LIMITED');
    const retry = blocked.json().details.retryAfterSec;
    expect(retry).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBe(String(retry));

    expect((await refresh('10.0.0.2')).statusCode).toBe(401);

    // Bộ đếm nằm ở Redis (dùng chung giữa các instance api).
    const redis = new Redis(redisC.getConnectionUrl());
    expect((await redis.keys('throttle:*')).length).toBeGreaterThan(0);
    redis.disconnect();
  });

  it('otp/send chặt hơn mặc định: 10 request/phút/IP', async () => {
    const send = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/otp/send',
        payload: { email: `u${i}@example.com` },
        remoteAddress: '10.0.0.3',
      });
    for (let i = 0; i < 10; i++) {
      expect((await send(i)).statusCode).not.toBe(429);
    }
    expect((await send(10)).statusCode).toBe(429);
  });

  it('health không bị tính giới hạn', async () => {
    for (let i = 0; i < 320; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        remoteAddress: '10.0.0.4',
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
