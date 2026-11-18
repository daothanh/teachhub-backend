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

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import { validateEnv, type Env } from '@teachhub/core';
import { JwtKeysService } from './jwt-keys.service.js';

const ec = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pkcs8 = (k: KeyObject) =>
  k.export({ format: 'pem', type: 'pkcs8' }).toString();
const spki = (k: KeyObject) =>
  k.export({ format: 'pem', type: 'spki' }).toString();

const service = (env: Partial<Env>) =>
  new JwtKeysService({
    get: (k: keyof Env) => ({ JWT_KID: 'k1', ...env })[k],
  } as unknown as ConfigService<Env, true>);

const claims = { userId: 'u-1', sessionId: 's-1', membershipsVersion: 3 };

/** Token tự ký để thử các ca lỗi. */
const forge = (
  key: KeyObject | Uint8Array,
  opts: { kid?: string; alg?: string; exp?: number | string; payload?: object },
) =>
  new SignJWT({ sid: 's-1', mv: 3, ...opts.payload })
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: opts.kid ?? 'k1' })
    .setSubject('u-1')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '15m')
    .sign(key);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code,
  );

describe('JwtKeysService (S1-BE-03)', () => {
  const current = ec();
  const jwt = service({ JWT_PRIVATE_KEY: pkcs8(current.privateKey) });

  it('ký rồi xác minh ra đúng claim; header có kid', async () => {
    const token = await jwt.sign(claims);
    expect(JSON.parse(atob(token.split('.')[0]!))).toMatchObject({
      alg: 'ES256',
      kid: 'k1',
    });
    expect(await jwt.verify(token)).toEqual(claims);
  });

  it('hết hạn → TOKEN_EXPIRED', async () => {
    const token = await forge(current.privateKey, {
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    expect(await codeOf(jwt.verify(token))).toBe('TOKEN_EXPIRED');
  });

  it.each([
    ['sai chữ ký (khóa khác, cùng kid)', () => forge(ec().privateKey, {})],
    ['kid lạ', () => forge(current.privateKey, { kid: 'k9' })],
    [
      'HS256 thay ES256',
      () => forge(new TextEncoder().encode('x'.repeat(32)), { alg: 'HS256' }),
    ],
    [
      'thiếu sid/mv',
      () => forge(current.privateKey, { payload: { sid: undefined, mv: 'x' } }),
    ],
    ['chuỗi rác', () => Promise.resolve('abc.def.ghi')],
  ])('%s → UNAUTHENTICATED', async (_, make) => {
    expect(await codeOf(jwt.verify(await make()))).toBe('UNAUTHENTICATED');
  });

  it('sửa payload sau khi ký → UNAUTHENTICATED', async () => {
    const [h, , s] = (await jwt.sign(claims)).split('.');
    const body = Buffer.from(
      JSON.stringify({ sub: 'u-2', sid: 's-1', mv: 3, exp: 9e9 }),
    ).toString('base64url');
    expect(await codeOf(jwt.verify(`${h}.${body}.${s}`))).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('xoay vòng: token ký bằng khóa cũ vẫn hợp lệ, JWKS có cả hai khóa công khai', async () => {
    const old = ec();
    const rotated = service({
      JWT_PRIVATE_KEY: pkcs8(current.privateKey),
      JWT_PREVIOUS_PUBLIC_KEY: spki(old.publicKey),
      JWT_PREVIOUS_KID: 'k0',
    });
    const token = await forge(old.privateKey, { kid: 'k0' });
    expect(await rotated.verify(token)).toEqual(claims);
    expect(rotated.jwks.keys.map((k) => k.kid)).toEqual(['k1', 'k0']);
    expect(rotated.jwks.keys.every((k) => !('d' in k))).toBe(true);
  });

  it('PEM một dòng có \\n (dạng biến môi trường) dùng được', async () => {
    const oneLine = service({
      JWT_PRIVATE_KEY: pkcs8(current.privateKey).replace(/\n/g, '\\n'),
    });
    expect(await jwt.verify(await oneLine.sign(claims))).toEqual(claims);
  });

  it('không nhận khóa không phải P-256', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => service({ JWT_PRIVATE_KEY: pkcs8(rsa.privateKey) })).toThrow(
      /P-256/,
    );
  });

  it('ngoài local/test thiếu JWT_PRIVATE_KEY → không khởi động', () => {
    const base = {
      DATABASE_URL: 'postgres://a@b/c',
      REDIS_URL: 'redis://a',
      S3_REGION: 'x',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
    };
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /JWT_PRIVATE_KEY/,
    );
    expect(() => validateEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
  });
});
