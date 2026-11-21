import helmet from '@fastify/helmet';
import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { type Env, genRequestId } from '@teachhub/core';
import { ApiModule } from './api.module.js';

/** Dựng app (dùng chung cho main.ts và test e2e). */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    new FastifyAdapter({
      bodyLimit: 1024 * 1024,
      // Chỉ tin đúng số proxy phía trước (Cloudflare = 1; thêm Caddy trên VM = 2): IP client là mục do proxy
      // gần nhất ghi vào X-Forwarded-For; mục client tự chèn ở đầu header bị bỏ qua (giới hạn theo IP).
      // Dạng hàm (kiểu của FastifyAdapter không nhận số): tin hop thứ i khi i < số proxy.
      trustProxy: (_addr: string, i: number) =>
        i < Number(process.env.TRUST_PROXY_HOPS ?? 1),
      genReqId: genRequestId,
    }),
    { bufferLogs: true },
  );
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  // request.id (log, body lỗi) trả lại cho client để truy vết end-to-end (Mục 3.5).
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (req, reply) => {
      void reply.header('x-request-id', req.id);
    });
  // Route nhận token/mã mời: không cache, không lộ qua Referer (kể cả khi lỗi, nên đặt ở hook chứ không ở handler).
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (req, reply) => {
      if (
        /^\/v1\/invites\/(preview|accept|redeem-code)$/.test(
          req.url.split('?')[0]!,
        )
      ) {
        void reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer');
      }
    });
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: '.well-known/jwks.json', method: RequestMethod.GET },
    ],
  });
  await app.register(helmet);
  app.enableCors({ origin: config.get('CORS_ORIGINS'), credentials: true });
  app.enableShutdownHooks();
  return app;
}
