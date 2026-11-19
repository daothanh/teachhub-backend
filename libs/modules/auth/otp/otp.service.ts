import { createHash, randomInt } from 'node:crypto';
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

/** Mục đích mã (khớp `purpose` của `POST /auth/otp/send`): mã mục đích này không dùng được cho mục đích kia. */
export type OtpPurpose = 'login' | 'delete_account';

/** So và tiêu mã trong một bước: mã đổi giữa chừng (gửi mã mới) không bị request cũ tiêu nhầm. */
const CONSUME_IF_MATCH = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** Mã OTP email trong Redis: chỉ lưu băm, khóa theo băm email (không để email thô trong Redis). */
@Injectable()
export class OtpService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * `code` và `cooldown` tách theo mục đích (khóa `login` giữ nguyên dạng cũ); `hour`, `fail`, `lock` dùng chung theo email:
   * giới hạn gửi 5 lần/giờ và khóa sai mã tính chung cho mọi mục đích.
   */
  private key(
    kind: 'code' | 'cooldown' | 'hour' | 'fail' | 'lock',
    email: string,
    purpose: OtpPurpose = 'login',
  ) {
    const scoped =
      (kind === 'code' || kind === 'cooldown') && purpose !== 'login';
    return `otp:${kind}${scoped ? `:${purpose}` : ''}:${sha256(email)}`;
  }

  /** Băm có mục đích: dù khóa Redis bị đọc nhầm, mã `login` không khớp mã `delete_account`. */
  private hash(email: string, code: string, purpose: OtpPurpose) {
    return sha256(
      purpose === 'login' ? `${email}:${code}` : `${purpose}:${email}:${code}`,
    );
  }

  private async rateLimited(key: string): Promise<never> {
    throw new AppException('RATE_LIMITED', {
      retryAfterSec: Math.max(await this.redis.ttl(key), 1),
    });
  }

  /** Sinh và lưu mã mới (thay mã cũ); trả mã để gửi email. */
  async issue(email: string, purpose: OtpPurpose = 'login'): Promise<string> {
    // Đang khóa thì không cấp mã mới: mã mới không mở khóa, chỉ thêm đường cho request đoán mã đang chạy dở.
    const lock = this.key('lock', email);
    if ((await this.redis.ttl(lock)) > 0) return this.rateLimited(lock);
    const cooldown = this.key('cooldown', email, purpose);
    if (!(await this.redis.set(cooldown, '1', 'EX', OTP.cooldownSec, 'NX'))) {
      return this.rateLimited(cooldown);
    }
    const hour = this.key('hour', email);
    const sent = await this.redis.incr(hour);
    await this.redis.expire(hour, 3600, 'NX');
    if (sent > OTP.perHour) return this.rateLimited(hour);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redis.set(
      this.key('code', email, purpose),
      this.hash(email, code, purpose),
      'EX',
      OTP.ttlSec,
    );
    return code;
  }

  /**
   * Đúng → mã bị hủy (dùng một lần). Sai/hết hạn → OTP_INVALID; lần thứ 5 sai → khóa 15 phút, OTP_LOCKED.
   * Đếm lượt TRƯỚC khi so (INCR nguyên tử): request đoán mã gửi song song cũng chỉ được so tối đa 5 lần.
   */
  async verify(
    email: string,
    code: string,
    purpose: OtpPurpose = 'login',
  ): Promise<void> {
    const lock = this.key('lock', email);
    const ensureUnlocked = async () => {
      const locked = await this.redis.ttl(lock);
      if (locked > 0) {
        throw new AppException('OTP_LOCKED', { retryAfterSec: locked });
      }
    };
    await ensureUnlocked();
    const codeKey = this.key('code', email, purpose);
    // Không có mã thì không có gì để dò: không đếm, để người lạ không khóa được email của người khác.
    if (!(await this.redis.exists(codeKey))) {
      throw new AppException('OTP_INVALID');
    }

    const attemptKey = this.key('fail', email);
    const attempt = await this.redis.incr(attemptKey);
    await this.redis.expire(attemptKey, OTP.lockSec, 'NX');
    // Bộ đếm hết hạn cùng khóa (không xóa khi khóa): request đang chạy dở không được đếm lại từ đầu.
    const lockNow = async () => {
      await this.redis.set(lock, '1', 'EX', OTP.lockSec);
      await this.redis.del(codeKey);
      throw new AppException('OTP_LOCKED', { retryAfterSec: OTP.lockSec });
    };
    if (attempt > OTP.maxFails) return lockNow();
    await ensureUnlocked();

    const consumed = await this.redis.eval(
      CONSUME_IF_MATCH,
      1,
      codeKey,
      this.hash(email, code, purpose),
    );
    if (consumed === 1) {
      await this.redis.del(attemptKey);
      return;
    }
    if (attempt >= OTP.maxFails) return lockNow();
    throw new AppException('OTP_INVALID');
  }
}
