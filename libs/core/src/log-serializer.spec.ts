import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pinoHttp } from 'pino-http';
import { reqLogSerializer } from './log-serializer.js';

describe('log request thật (pino-http + reqLogSerializer)', () => {
  it('một dòng log không chứa query, referer, cookie, authorization hay PII', async () => {
    const lines: string[] = [];
    const logger = pinoHttp(
      { serializers: { req: reqLogSerializer } },
      { write: (l: string) => void lines.push(l) },
    );
    const server = http
      .createServer((req, res) => {
        logger(req, res);
        res.end('ok');
      })
      .listen(0);
    const { port } = server.address() as AddressInfo;
    await fetch(
      `http://127.0.0.1:${port}/v1/students?q=Nguyen&phone=0912345678`,
      {
        headers: {
          referer: 'https://app.example/search?q=Nguyen+Van+A',
          cookie: 'sid=secret',
          authorization: 'Bearer tok',
          'user-agent': 'vitest',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    const line = lines.join('');
    expect(line).toContain('"url":"/v1/students"');
    expect(line).toContain('"user-agent":"vitest"');
    for (const bad of [
      'q=',
      'Nguyen',
      '0912345678',
      'referer',
      'secret',
      'Bearer',
      'cookie',
    ]) {
      expect(line).not.toContain(bad);
    }
  });
});
