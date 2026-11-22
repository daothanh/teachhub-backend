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

import type { TxService } from '@teachhub/db';
import type { Redis } from 'ioredis';
import { InviteAttemptLimiter } from './invite-attempt-limiter.js';

// Script RESERVE chạy trong Redis thật (e2e `invites.e2e-spec.ts`); ở đây kiểm tham số gửi đi và cách đọc kết quả.
describe('InviteAttemptLimiter.reserve', () => {
  const setup = (res: number[]) => {
    const evalFn = vi.fn().mockResolvedValue(res);
    const run = vi.fn().mockResolvedValue(undefined);
    const limiter = new InviteAttemptLimiter(
      { eval: evalFn } as unknown as Redis,
      { run } as unknown as TxService,
    );
    return { limiter, evalFn, run };
  };
  const PTTL = 60_000;

  it('đổi mã ngắn: gửi khóa user, IP, toàn cục và vị trí khóa toàn cục (cuối) để script xét lần sai trước đó', async () => {
    const { limiter, evalFn } = setup([1, PTTL, 0, 1, PTTL, 0, 1, PTTL, 0]);
    await expect(
      limiter.reserve('accept', 'u1', '198.51.100.1', true),
    ).resolves.toEqual({
      keys: [
        'inv:f:accept:u:u1',
        'inv:f:accept:ip:198.51.100.1',
        'inv:f:accept:g',
      ],
    });
    expect(evalFn.mock.calls[0]!.slice(1)).toEqual([
      3,
      'inv:f:accept:u:u1',
      'inv:f:accept:ip:198.51.100.1',
      'inv:f:accept:g',
      900,
      5,
      20,
      500,
      3,
    ]);
  });

  it('không có lớp toàn cục → vị trí 0', async () => {
    const { limiter, evalFn } = setup([1, PTTL, 0]);
    await limiter.reserve('preview', null, '198.51.100.1');
    expect(evalFn.mock.calls[0]!.slice(1)).toEqual([
      1,
      'inv:f:preview:ip:198.51.100.1',
      900,
      20,
      0,
    ]);
  });

  it('toàn cục vượt trần nhưng script báo không chặn (người chưa sai lần nào) → được thử', async () => {
    const { limiter, run } = setup([1, PTTL, 0, 1, PTTL, 0, 777, PTTL, 0]);
    await expect(
      limiter.reserve('accept', 'u1', '198.51.100.1', true),
    ).resolves.toMatchObject({ keys: expect.any(Array) });
    expect(run).not.toHaveBeenCalled();
  });

  it('toàn cục chặn (user/IP đã sai) → 429 RATE_LIMITED', async () => {
    const { limiter } = setup([2, PTTL, 0, 2, PTTL, 0, 777, PTTL, 1]);
    await expect(
      limiter.reserve('accept', 'u1', '198.51.100.1', true),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSec: 60 },
    });
  });

  it('lớp user chặn → 429 INVITE_CODE_LOCKED, audit ở lượt đầu tiên vượt ngưỡng', async () => {
    const { limiter, run } = setup([6, PTTL, 1, 6, PTTL, 0, 10, PTTL, 0]);
    await expect(
      limiter.reserve('accept', 'u1', '198.51.100.1', true),
    ).rejects.toMatchObject({ code: 'INVITE_CODE_LOCKED' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
