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

import type { Redis } from 'ioredis';
import { OTP, OtpService } from './otp.service.js';

/** Redis giả trong bộ nhớ, chỉ đủ các lệnh OtpService dùng (TTL tính bằng giây, không tự hết hạn). */
function fakeRedis() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const r = {
    data,
    ttl: async (k: string) => (data.has(k) ? (ttls.get(k) ?? -1) : -2),
    set: async (k: string, v: string, _ex: 'EX', sec: number, nx?: 'NX') => {
      if (nx && data.has(k)) return null;
      data.set(k, v);
      ttls.set(k, sec);
      return 'OK';
    },
    incr: async (k: string) => {
      const n = Number(data.get(k) ?? 0) + 1;
      data.set(k, String(n));
      return n;
    },
    expire: async (k: string, sec: number, nx?: 'NX') => {
      if (!data.has(k) || (nx && ttls.has(k))) return 0;
      ttls.set(k, sec);
      return 1;
    },
    del: async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) {
        if (data.delete(k)) n++;
        ttls.delete(k);
      }
      return n;
    },
    exists: async (k: string) => (data.has(k) ? 1 : 0),
    // Chỉ có một script: CONSUME_IF_MATCH.
    eval: async (_s: string, _n: number, k: string, v: string) =>
      data.get(k) === v ? r.del(k) : 0,
  };
  return r;
}

const EMAIL = 'nan.nhan@example.com';
const ATTACKER = '203.0.113.7';
const OWNER = '198.51.100.9';

const wrong = (code: string) =>
  ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

describe('OtpService', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let otp: OtpService;
  beforeEach(() => {
    redis = fakeRedis();
    otp = new OtpService(redis as unknown as Redis);
  });

  const codeOf = (e: unknown) => (e as { code?: string }).code;
  const fails = async (code: string, ip: string, n: number) => {
    const out: (string | undefined)[] = [];
    for (let i = 0; i < n; i++)
      out.push(
        await otp.verify(EMAIL, wrong(code), ip).then(
          () => 'OK',
          (e: unknown) => codeOf(e),
        ),
      );
    return out;
  };

  it('sai 5 lần từ một IP → IP đó bị khóa, chủ email ở IP khác vẫn đăng nhập được bằng mã đang có', async () => {
    const code = await otp.issue(EMAIL, OWNER);
    expect(await fails(code, ATTACKER, 6)).toEqual([
      'OTP_INVALID',
      'OTP_INVALID',
      'OTP_INVALID',
      'OTP_INVALID',
      'OTP_LOCKED',
      'OTP_LOCKED',
    ]);
    // Mã đúng từ IP đã khóa vẫn bị chặn.
    await expect(otp.verify(EMAIL, code, ATTACKER)).rejects.toMatchObject({
      code: 'OTP_LOCKED',
    });
    await expect(otp.verify(EMAIL, code, OWNER)).resolves.toBeUndefined();
  });

  it('issue chỉ từ chối IP đang bị khóa với email đó', async () => {
    const code = await otp.issue(EMAIL, OWNER);
    await fails(code, ATTACKER, 5);
    for (const k of redis.data.keys())
      if (k.startsWith('otp:cooldown:')) redis.data.delete(k);
    await expect(otp.issue(EMAIL, ATTACKER)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(otp.issue(EMAIL, OWNER)).resolves.toMatch(/^\d{6}$/);
  });

  it('IPv6 cùng /64 chung một bộ đếm', async () => {
    const code = await otp.issue(EMAIL, OWNER);
    for (let i = 0; i < 4; i++)
      await expect(
        otp.verify(EMAIL, wrong(code), `2001:db8:1:2::${i + 1}`),
      ).rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(
      otp.verify(EMAIL, wrong(code), '2001:db8:1:2:ffff::9'),
    ).rejects.toMatchObject({ code: 'OTP_LOCKED' });
    await expect(otp.verify(EMAIL, code, OWNER)).resolves.toBeUndefined();
  });

  it(`đoán qua nhiều IP: quá ${OTP.maxFailsPerHour} lượt sai/giờ → hủy mã; xin mã mới không mở thêm lượt`, async () => {
    const code = await otp.issue(EMAIL, OWNER);
    // 5 IP × 4 lần sai = 20 lượt, chưa IP nào bị khóa.
    for (let i = 0; i < OTP.maxFailsPerHour / 4; i++)
      expect(await fails(code, `203.0.113.${i + 10}`, 4)).toEqual(
        Array(4).fill('OTP_INVALID'),
      );
    // Lượt 21 (IP mới, mã đúng) cũng không được so: mã đã hủy.
    await expect(otp.verify(EMAIL, code, OWNER)).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    const clearCooldown = () => {
      for (const k of redis.data.keys())
        if (k.startsWith('otp:cooldown:')) redis.data.delete(k);
    };
    // Mã mới trong cùng giờ không đặt lại bộ đếm: dò tiếp vẫn bị chặn.
    clearCooldown();
    const again = await otp.issue(EMAIL, OWNER);
    await expect(otp.verify(EMAIL, again, OWNER)).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    // Hết cửa sổ (khóa cfail hết hạn) thì mã mới dùng được.
    for (const k of redis.data.keys())
      if (k.startsWith('otp:cfail:')) redis.data.delete(k);
    clearCooldown();
    const fresh = await otp.issue(EMAIL, OWNER);
    await expect(otp.verify(EMAIL, fresh, OWNER)).resolves.toBeUndefined();
  });

  it('nhập đúng thì xóa bộ đếm lượt sai theo giờ của email', async () => {
    const code = await otp.issue(EMAIL, OWNER);
    expect(await fails(code, '203.0.113.50', 4)).toEqual(
      Array(4).fill('OTP_INVALID'),
    );
    await expect(otp.verify(EMAIL, code, OWNER)).resolves.toBeUndefined();
    expect([...redis.data.keys()].some((k) => k.startsWith('otp:cfail:'))).toBe(
      false,
    );
  });

  it('không có mã thì nhập sai không đếm', async () => {
    for (let i = 0; i < 10; i++)
      await expect(otp.verify(EMAIL, '000000', ATTACKER)).rejects.toMatchObject(
        { code: 'OTP_INVALID' },
      );
    const code = await otp.issue(EMAIL, ATTACKER);
    await expect(otp.verify(EMAIL, code, ATTACKER)).resolves.toBeUndefined();
  });

  it('mã một mục đích không dùng được cho mục đích khác; dùng một lần', async () => {
    const code = await otp.issue(EMAIL, OWNER, 'delete_account');
    await expect(otp.verify(EMAIL, code, OWNER)).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    await expect(
      otp.verify(EMAIL, code, OWNER, 'delete_account'),
    ).resolves.toBeUndefined();
    await expect(
      otp.verify(EMAIL, code, OWNER, 'delete_account'),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });
});
