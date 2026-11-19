import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppException } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { REDIS } from '@teachhub/infra';
import { ipBucket } from '../domain/ip-bucket.js';

export type AttemptScope = 'accept' | 'preview';

const WINDOW_SEC = 15 * 60;
/**
 * Ngưỡng lần SAI trong 15 phút. User: 5 (US-0.12 AC5). IP cao hơn vì một IP có thể là wifi chung của cả trường;
 * toàn cục chặn dò phân tán nhiều IP/tài khoản.
 */
const LIMITS = {
  accept: { user: 5, ip: 20, global: 500 },
  preview: { user: Infinity, ip: 20, global: 1000 },
} as const;

/**
 * Bộ đếm lần sai nhận lời mời trong Redis, ba lớp (user, IP /64, toàn cục). Chỉ đếm lỗi 410 của token/mã;
 * 422 sai định dạng, phát lại phản hồi đã lưu và lỗi hệ thống không đếm (xem `InviteAcceptanceService`).
 */
@Injectable()
export class InviteAttemptLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tx: TxService,
  ) {}

  private keys(scope: AttemptScope, userId: string | null, ip: string) {
    return {
      user: userId ? `inv:f:${scope}:u:${userId}` : null,
      ip: `inv:f:${scope}:ip:${ipBucket(ip)}`,
      global: `inv:f:${scope}:g`,
    };
  }

  /** Gọi TRƯỚC khi tra mã: đã bị khóa thì 429, kể cả khi lần này nhập đúng. */
  async assertNotLocked(
    scope: AttemptScope,
    userId: string | null,
    ip: string,
  ): Promise<void> {
    const k = this.keys(scope, userId, ip);
    const lim = LIMITS[scope];
    const [u, i, g] = await Promise.all([
      k.user ? this.redis.get(k.user) : null,
      this.redis.get(k.ip),
      this.redis.get(k.global),
    ]);
    const retry = async (key: string) =>
      Math.max(Math.ceil((await this.redis.pttl(key)) / 1000), 1);
    if (k.user && Number(u) >= lim.user) {
      throw new AppException('INVITE_CODE_LOCKED', {
        retryAfterSec: await retry(k.user),
      });
    }
    if (Number(i) >= lim.ip) {
      throw new AppException(
        scope === 'accept' ? 'INVITE_CODE_LOCKED' : 'RATE_LIMITED',
        { retryAfterSec: await retry(k.ip) },
      );
    }
    if (Number(g) >= lim.global) {
      throw new AppException('RATE_LIMITED', {
        retryAfterSec: await retry(k.global),
      });
    }
  }

  /** Ghi một lần sai; chạm ngưỡng thì audit "khóa" (không chứa token/mã). */
  async recordFailure(
    scope: AttemptScope,
    userId: string | null,
    ip: string,
  ): Promise<void> {
    const k = this.keys(scope, userId, ip);
    const lim = LIMITS[scope];
    const hit = async (key: string) => {
      const r = await this.redis
        .multi()
        .incr(key)
        .expire(key, WINDOW_SEC, 'NX')
        .exec();
      return Number(r?.[0]?.[1]);
    };
    const [u, i, g] = await Promise.all([
      k.user ? hit(k.user) : 0,
      hit(k.ip),
      hit(k.global),
    ]);
    const locked: string[] = [];
    if (k.user && u === lim.user) locked.push('user');
    if (i === lim.ip) locked.push('ip');
    if (g === lim.global) locked.push('global');
    for (const layer of locked) await this.auditLock(scope, userId, layer);
  }

  private auditLock(scope: AttemptScope, userId: string | null, layer: string) {
    return this.tx.run({ userId }, (t) =>
      t.execute(
        sql`select app_private.audit_insert(null, 'invite_lock', null, 'update', null,
              ${JSON.stringify({ scope, layer, windowSec: WINDOW_SEC })}::jsonb)`,
      ),
    );
  }

  /** Dấu "410 đã trả cho (user, khóa idempotency, bí mật này)": phát lại cùng khóa không bị đếm lần nữa. */
  async seenFailure(marker: string): Promise<boolean> {
    return (await this.redis.exists(`inv:410:${marker}`)) === 1;
  }

  async markFailure(marker: string): Promise<void> {
    await this.redis.set(`inv:410:${marker}`, '1', 'EX', WINDOW_SEC);
  }
}
