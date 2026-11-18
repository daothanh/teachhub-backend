import {
  type ExecutionContext,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  ThrottlerModule,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { AppException, type Env } from '@teachhub/core';
import { REDIS, RedisModule } from './redis.module.js';

// 6.7.1 chưa export kiểu này ở gốc gói.
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/** Đếm theo cửa sổ cố định trong Redis: nhiều instance api dùng chung bộ đếm (§2.6). */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    name: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${name}:${key}`;
    const blockKey = `${hitsKey}:block`;
    const sec = (ms: number) => Math.max(Math.ceil(ms / 1000), 1);

    const blockedFor = await this.redis.pttl(blockKey);
    if (blockedFor > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: sec(blockedFor),
        isBlocked: true,
        timeToBlockExpire: sec(blockedFor),
      };
    }
    const res = await this.redis
      .multi()
      .incr(hitsKey)
      .pexpire(hitsKey, ttl, 'NX')
      .pttl(hitsKey)
      .exec();
    const hits = Number(res?.[0]?.[1]);
    const left = Number(res?.[2]?.[1]);
    if (hits > limit) {
      await this.redis.set(blockKey, '1', 'PX', blockDuration);
      return {
        totalHits: hits,
        timeToExpire: sec(left),
        isBlocked: true,
        timeToBlockExpire: sec(blockDuration),
      };
    }
    return {
      totalHits: hits,
      timeToExpire: sec(left),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}

/** Vượt giới hạn → 429 RATE_LIMITED + `details.retryAfterSec` (+ `Retry-After`), cùng dạng với OTP. */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  @Inject(ConfigService) private readonly config!: ConfigService<Env, true>;

  protected override handleRequest(p: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...p,
      limit: p.limit * this.config.get('RATE_LIMIT_SCALE'),
    });
  }

  protected override async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new AppException('RATE_LIMITED', {
      retryAfterSec: detail.timeToBlockExpire,
    });
  }
}

/**
 * Giới hạn theo IP (sau Cloudflare: `trustProxy`, IP thật của client). Mặc định 300 request/phút; endpoint
 * đăng nhập đặt `@Throttle` chặt hơn. Lớp chặn thứ hai cạnh giới hạn theo email của OTP.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [REDIS],
      useFactory: (redis: Redis) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        storage: new RedisThrottlerStorage(redis),
        setHeaders: false,
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class ThrottleModule {}
