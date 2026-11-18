import { readFileSync, writeFileSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const FILE = 'contracts/openapi.json';

// contracts/openapi.json phải khớp mã: đổi schema mà quên chạy `pnpm openapi:gen` → test đỏ.
// Không cần PostgreSQL/Redis/S3 thật: kết nối đều mở lười.
describe('contracts/openapi.json', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
      REDIS_URL: 'redis://127.0.0.1:1',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
    });
    const { createApp } = await import('./app.js');
    app = await createApp();
  });

  afterAll(() => app?.close());

  it('khớp với hợp đồng do controller sinh ra', async () => {
    const { buildOpenApiDocument } = await import('./openapi.js');
    const generated = `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI) writeFileSync(FILE, generated);
    expect(
      readFileSync(FILE, 'utf8'),
      'contracts/openapi.json lệch với mã — chạy `pnpm openapi:gen` rồi commit',
    ).toBe(generated);
  });
});
