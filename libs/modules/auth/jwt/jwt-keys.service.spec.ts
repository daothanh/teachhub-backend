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
import { secretKey, validateEnv, type Env } from '@teachhub/core';
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

const USER = '019a8f3e-7c1b-7d2a-9b3e-5f6a7b8c9d0e';
const claims = { userId: USER, sessionId: 's-1', membershipsVersion: 3 };

/** Token tự ký để thử các ca lỗi. */
const forge = (
  key: KeyObject | Uint8Array,
  opts: {
    kid?: string;
    alg?: string;
    exp?: number | string;
    payload?: object;
    sub?: string;
  },
) =>
  new SignJWT({ sid: 's-1', mv: 3, ...opts.payload })
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: opts.kid ?? 'k1' })
    .setSubject(opts.sub ?? USER)
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
    ['sub không phải UUID', () => forge(current.privateKey, { sub: 'u-1' })],
  ])('%s → UNAUTHENTICATED', async (_, make) => {
    expect(await codeOf(jwt.verify(await make()))).toBe('UNAUTHENTICATED');
  });

  it('sửa payload sau khi ký → UNAUTHENTICATED', async () => {
    const [h, , s] = (await jwt.sign(claims)).split('.');
    const body = Buffer.from(
      JSON.stringify({
        sub: USER.replace('9d0e', '9d0f'),
        sid: 's-1',
        mv: 3,
        exp: 9e9,
      }),
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
    // Thiếu NODE_ENV không được coi là local: bắt buộc khóa.
    expect(() => validateEnv({ ...base })).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('staging/production bắt buộc GOOGLE_CLIENT_IDS và APPLE_BUNDLE_ID; APPLE_BUNDLE_ID nhận danh sách', () => {
    const base = {
      DATABASE_URL: 'postgres://a@b/c',
      REDIS_URL: 'redis://a',
      S3_REGION: 'x',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
      JWT_PRIVATE_KEY: 'k',
      CONSENT_IP_HMAC_KEY: 'a'.repeat(32),
      INVITE_CODE_HMAC_KEY: 'b'.repeat(32),
      IDEMPOTENCY_ENC_KEY: 'c'.repeat(32),
      NODE_ENV: 'staging',
    };
    expect(() => validateEnv(base)).toThrow(/APPLE_BUNDLE_ID/);
    const ok = validateEnv({
      ...base,
      GOOGLE_CLIENT_IDS: 'g',
      APPLE_BUNDLE_ID: 'a.b, c.d',
    });
    expect(ok.APPLE_BUNDLE_ID).toEqual(['a.b', 'c.d']);
  });

  it('ngoài local/test bắt buộc ba khóa bí mật mời/consent và chúng phải khác nhau; secretKey fail closed', () => {
    const base = {
      DATABASE_URL: 'postgres://a@b/c',
      REDIS_URL: 'redis://a',
      S3_REGION: 'x',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
      JWT_PRIVATE_KEY: 'k',
      NODE_ENV: 'development',
    };
    expect(() => validateEnv(base)).toThrow(/CONSENT_IP_HMAC_KEY/);
    const keys = {
      CONSENT_IP_HMAC_KEY: 'a'.repeat(32),
      INVITE_CODE_HMAC_KEY: 'b'.repeat(32),
      IDEMPOTENCY_ENC_KEY: 'c'.repeat(32),
    };
    expect(() => validateEnv({ ...base, ...keys })).not.toThrow();
    expect(() =>
      validateEnv({ ...base, ...keys, IDEMPOTENCY_ENC_KEY: 'a'.repeat(32) }),
    ).toThrow(/phải khác nhau/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      expect(() => secretKey(undefined, 'X')).toThrow(/Thiếu khóa/);
      delete process.env.NODE_ENV;
      expect(() => secretKey(undefined, 'X')).toThrow(/Thiếu khóa/);
      process.env.NODE_ENV = 'test';
      expect(secretKey(undefined, 'X')).toContain('dev-only');
      expect(secretKey('v', 'X')).toBe('v');
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
