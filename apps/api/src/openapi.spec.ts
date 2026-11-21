import { readFileSync, writeFileSync } from 'node:fs';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
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

  // POST mặc định 201: route khai thành công 200/204 mà quên @HttpCode thì hợp đồng nói dối.
  it('mã thành công khai trong hợp đồng khớp @HttpCode của route POST', () => {
    const wrong: string[] = [];
    for (const { instance } of new DiscoveryService(
      app.get(ModulesContainer),
    ).getControllers()) {
      if (!instance) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata('method', handler) !== 1 /* POST */) continue;
        const declared = Object.keys(
          (Reflect.getMetadata('swagger/apiResponse', handler) ?? {}) as object,
        ).filter((c) => c.startsWith('2'));
        // Có cả 200 và 201: thân hàm tự đặt status qua reply.
        if (declared.length !== 1) continue;
        const actual = String(
          Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? 201,
        );
        if (actual !== declared[0]) {
          wrong.push(
            `${proto.constructor.name}.${name}: khai ${declared[0]}, chạy ${actual}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
