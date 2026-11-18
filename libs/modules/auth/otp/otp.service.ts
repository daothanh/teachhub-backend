import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '@teachhub/core';
import { REDIS } from '@teachhub/infra';

/** US-0.1 AC3 và S1-BE-04: mã sống 5 phút; gửi 60 giây/lần, 5 lần/giờ; sai 5 lần → khóa 15 phút. */
export const OTP = {
  ttlSec: 300,
  cooldownSec: 60,
  perHour: 5,
  maxFails: 5,
  lockSec: 900,
} as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Mã OTP email trong Redis: chỉ lưu băm, khóa theo băm email (không để email thô trong Redis). */
@Injectable()
export class OtpService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(
    kind: 'code' | 'cooldown' | 'hour' | 'fail' | 'lock',
    email: string,
  ) {
    return `otp:${kind}:${sha256(email)}`;
  }

  private hash(email: string, code: string) {
    return sha256(`${email}:${code}`);
  }

  private async rateLimited(key: string): Promise<never> {
    throw new AppException('RATE_LIMITED', {
      retryAfterSec: Math.max(await this.redis.ttl(key), 1),
    });
  }

  /** Sinh và lưu mã mới (thay mã cũ); trả mã để gửi email. */
  async issue(email: string): Promise<string> {
    const cooldown = this.key('cooldown', email);
    if (!(await this.redis.set(cooldown, '1', 'EX', OTP.cooldownSec, 'NX'))) {
      return this.rateLimited(cooldown);
    }
    const hour = this.key('hour', email);
    const sent = await this.redis.incr(hour);
    await this.redis.expire(hour, 3600, 'NX');
    if (sent > OTP.perHour) return this.rateLimited(hour);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redis.set(
      this.key('code', email),
      this.hash(email, code),
      'EX',
      OTP.ttlSec,
    );
    return code;
  }

  /** Đúng → mã bị hủy (dùng một lần). Sai/hết hạn → OTP_INVALID; sai lần thứ 5 → khóa, OTP_LOCKED. */
  async verify(email: string, code: string): Promise<void> {
    const lock = this.key('lock', email);
    const locked = await this.redis.ttl(lock);
    if (locked > 0) {
      throw new AppException('OTP_LOCKED', { retryAfterSec: locked });
    }
    const codeKey = this.key('code', email);
    const stored = await this.redis.get(codeKey);
    const given = Buffer.from(this.hash(email, code));
    if (
      stored &&
      timingSafeEqual(Buffer.from(stored), given) &&
      // Hai request đúng mã đồng thời: chỉ request xóa được mã mới thắng.
      (await this.redis.del(codeKey)) === 1
    ) {
      await this.redis.del(this.key('fail', email));
      return;
    }
    const failKey = this.key('fail', email);
    const fails = await this.redis.incr(failKey);
    await this.redis.expire(failKey, OTP.lockSec, 'NX');
    if (fails >= OTP.maxFails) {
      await this.redis.set(lock, '1', 'EX', OTP.lockSec);
      await this.redis.del(codeKey, failKey);
      throw new AppException('OTP_LOCKED', { retryAfterSec: OTP.lockSec });
    }
    throw new AppException('OTP_INVALID');
  }
}
