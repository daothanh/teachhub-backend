import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as Sentry from '@sentry/nestjs';
import { Module } from '@nestjs/common';

// S0-OPS-03: lỗi 5xx tới Sentry nhưng envelope không chứa body request / PII; 4xx không được báo.
const sent: string[] = [];

@Controller('boom')
class BoomController {
  @Post('500')
  five(@Body() body: { phone: string }): never {
    throw new Error(`hỏng khi xử lý ${body.phone} a@b.vn`);
  }
  @Post('400')
  four(): never {
    throw new BadRequestException();
  }
}

describe('Sentry: lọc PII (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // CoreModule kiểm tra env ngay khi nạp @teachhub/core (giá trị giả, không kết nối gì).
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
      REDIS_URL: 'redis://127.0.0.1:1',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
    });
    const { initSentry, GlobalExceptionFilter } =
      await import('@teachhub/core');
    initSentry(
      { SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1', NODE_ENV: 'test' },
      {
        transport: () => ({
          send: async (envelope) => {
            sent.push(JSON.stringify(envelope));
            return {};
          },
          flush: async () => true,
        }),
        // Không cài handler toàn cục / http instrumentation: test chỉ kiểm đường đi của filter.
        defaultIntegrations: false,
      },
    );
    @Module({
      controllers: [BoomController],
      providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
    })
    class TestModule {}
    app = await NestFactory.create<NestFastifyApplication>(
      TestModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await Sentry.close(2000);
    await app?.close();
  });

  it('5xx được báo, không lộ body/SĐT/email; 4xx không báo', async () => {
    const r400 = await app.inject({ method: 'POST', url: '/boom/400' });
    expect(r400.statusCode).toBe(400);
    const r500 = await app.inject({
      method: 'POST',
      url: '/boom/500',
      headers: { authorization: 'Bearer top-secret' },
      payload: { phone: '0912345678', fullName: 'Nguyen Van A' },
    });
    expect(r500.statusCode).toBe(500);
    await Sentry.flush(2000);

    const all = sent.join('\n');
    expect(all).toContain('hỏng khi xử lý');
    expect(all).not.toMatch(/0912345678|Nguyen|a@b\.vn|top-secret/);
    expect(sent.filter((s) => s.includes('"type":"event"'))).toHaveLength(1);
  });
});
