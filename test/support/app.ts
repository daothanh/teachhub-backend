import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import pg from 'pg';
import { startTestDb, type TestDb } from '../containers.js';

export interface TestApp {
  db: TestDb;
  redis: StartedRedisContainer;
  /** teachhub_worker (BYPASSRLS): dựng và đọc dữ liệu thẳng, bỏ qua RLS. */
  worker: pg.Pool;
  app: NestFastifyApplication;
  /** Access token của user đã có trong `users`. */
  tokenFor: (userId: string) => Promise<string>;
  stop: () => Promise<void>;
}

/** PostgreSQL + Redis (Testcontainers) và app api đã init, như các e2e khác. */
export async function startTestApp(
  /** Biến `S3_*` thật (vd. `startTestS3().env`) thay cho giá trị giả khi test cần kho S3. */
  s3Env: Record<string, string> = {},
): Promise<TestApp> {
  const [db, redis] = await Promise.all([
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
    ...s3Env,
  });
  const worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
  const { createApp } = await import('../../apps/api/src/app.js');
  const app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { SessionService } =
    await import('../../libs/modules/auth/session/session.service.js');
  return {
    db,
    redis,
    worker,
    app,
    tokenFor: async (userId) =>
      (await app.get(SessionService).open(userId)).access_token,
    stop: async () => {
      await app.close();
      await worker.end();
      await Promise.all([db.container.stop(), redis.stop()]);
    },
  };
}
