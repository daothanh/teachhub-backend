// @teachhub/core nạp ConfigModule (kiểm env) ngay khi import → đặt env tối thiểu trước.
vi.hoisted(() =>
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://a@b/c',
    REDIS_URL: 'redis://a',
    S3_REGION: 'x',
    S3_ACCESS_KEY_ID: 'x',
    S3_SECRET_ACCESS_KEY: 'x',
    S3_BUCKET_PRIVATE: 'x',
  }),
);

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, generateKeyPair, jwtVerify } from 'jose';
import { AppException } from '@teachhub/core';
import {
  isEmailVerified,
  mapIdTokenError,
  remoteKeys,
} from './id-token.util.js';

describe('mapIdTokenError', () => {
  const verify = async (url: string, token?: string) => {
    const { privateKey } = await generateKeyPair('RS256');
    const jwt =
      token ??
      (await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'k' })
        .setExpirationTime('1h')
        .sign(privateKey));
    return jwtVerify(jwt, remoteKeys(url), { algorithms: ['RS256'] }).catch(
      (e) => {
        throw mapIdTokenError(e);
      },
    );
  };

  it('JWKS ở cổng chết → 503', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    await expect(verify(`http://127.0.0.1:${port}/k`)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('JWKS trả 500 hoặc JSON hỏng → 503', async () => {
    for (const [status, body] of [
      [500, '{}'],
      [200, 'khong-phai-json'],
    ] as const) {
      const srv = createServer((_, res) => {
        res.statusCode = status;
        res.end(body);
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      await expect(
        verify(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/k`),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      srv.close();
    }
  });

  it('token rác → 401, không phải 503', async () => {
    const err = mapIdTokenError(new Error('x'));
    expect(err).toBeInstanceOf(Error);
    await expect(
      verify('http://127.0.0.1:1/k', 'abc.def.ghi'),
    ).rejects.toSatisfy(
      (e) => e instanceof AppException && e.code === 'UNAUTHENTICATED',
    );
  });
});

describe('isEmailVerified', () => {
  it('chỉ true hoặc "true" mới là đã xác minh', () => {
    expect([true, 'true'].map(isEmailVerified)).toEqual([true, true]);
    for (const v of [false, 'false', 0, 1, 'TRUE', null, undefined, {}])
      expect(isEmailVerified(v), String(v)).toBe(false);
  });
});
