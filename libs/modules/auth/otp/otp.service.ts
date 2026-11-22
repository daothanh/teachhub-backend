import { createHash, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException, ipBucket } from '@teachhub/core';
import { REDIS } from '@teachhub/infra';

/**
 * US-0.1 AC3 và S1-BE-04: mã sống 5 phút; gửi 60 giây/lần, 5 lần/giờ; sai 5 lần → khóa 15 phút.
 * Đếm sai và khóa theo (email, IP; IPv6 gộp /64): người lạ khóa được IP của chính họ, không khóa được email người khác.
 * `maxFailsPerHour`: trần lượt sai mọi IP cộng lại cho một email trong 1 giờ, KHÔNG đặt lại khi cấp mã mới; chạm trần thì
 * hủy mã và từ chối so tới hết cửa sổ, nên dò mã qua nhiều IP vẫn chỉ được ngần ấy lượt mỗi giờ. Đổi lại: người lạ có
 * nhiều IP vẫn chặn được đăng nhập OTP của một email tới hết giờ (còn Google/Apple).
 */
export const OTP = {
  ttlSec: 300,
  cooldownSec: 60,
  perHour: 5,
  maxFails: 5,
  lockSec: 900,
  maxFailsPerHour: 20,
} as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Mục đích mã (khớp `purpose` của `POST /auth/otp/send`): mã mục đích này không dùng được cho mục đích kia. */
export type OtpPurpose = 'login' | 'delete_account' | 'payout_account';

/** So và tiêu mã trong một bước: mã đổi giữa chừng (gửi mã mới) không bị request cũ tiêu nhầm. */
const CONSUME_IF_MATCH = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** Mã OTP email trong Redis: chỉ lưu băm, khóa theo băm email (không để email thô trong Redis). */
@Injectable()
export class OtpService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * `code`, `cooldown`, `cfail` tách theo mục đích (khóa `login` giữ nguyên dạng cũ); `hour` dùng chung theo email: giới hạn
   * gửi 5 lần/giờ tính chung cho mọi mục đích.
   */
  private key(
    kind: 'code' | 'cooldown' | 'hour' | 'cfail',
    email: string,
    purpose: OtpPurpose = 'login',
  ) {
    const scoped = kind !== 'hour' && purpose !== 'login';
    return `otp:${kind}${scoped ? `:${purpose}` : ''}:${sha256(email)}`;
  }

  /** `fail`, `lock` theo (email, IP bucket), dùng chung cho mọi mục đích; IP cũng băm, không để thô trong Redis. */
  private ipKey(kind: 'fail' | 'lock', email: string, ip: string | undefined) {
    return `otp:${kind}:${sha256(email)}:${sha256(ipBucket(ip))}`;
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

  /** Sinh và lưu mã mới (thay mã cũ); trả mã để gửi email. `ip`: IP client (đã qua trustProxy). */
  async issue(
    email: string,
    ip: string | undefined,
    purpose: OtpPurpose = 'login',
  ): Promise<string> {
    // IP này đang bị khóa với email thì không cấp mã mới: mã mới không mở khóa, chỉ thêm đường cho request đoán mã đang chạy dở.
    const lock = this.ipKey('lock', email, ip);
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
   * Đúng → mã bị hủy (dùng một lần). Sai/hết hạn → OTP_INVALID; lần thứ 5 sai từ cùng IP → khóa IP đó với email này
   * 15 phút, OTP_LOCKED. Mọi IP cộng lại quá `maxFailsPerHour` lượt sai trong giờ → hủy mã, OTP_INVALID tới hết cửa sổ.
   * Đếm lượt TRƯỚC khi so (INCR nguyên tử): request đoán mã gửi song song cũng không vượt được các trần trên.
   */
  async verify(
    email: string,
    code: string,
    ip: string | undefined,
    purpose: OtpPurpose = 'login',
  ): Promise<void> {
    const lock = this.ipKey('lock', email, ip);
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

    const attemptKey = this.ipKey('fail', email, ip);
    const attempt = await this.redis.incr(attemptKey);
    await this.redis.expire(attemptKey, OTP.lockSec, 'NX');
    // Bộ đếm hết hạn cùng khóa (không xóa khi khóa): request đang chạy dở không được đếm lại từ đầu.
    // Không hủy mã khi khóa: khóa chỉ chặn IP này, chủ email ở IP khác vẫn dùng được mã của mình.
    const lockNow = async () => {
      await this.redis.set(lock, '1', 'EX', OTP.lockSec);
      throw new AppException('OTP_LOCKED', { retryAfterSec: OTP.lockSec });
    };
    if (attempt > OTP.maxFails) return lockNow();
    await ensureUnlocked();

    // Bộ đếm theo email sống 1 giờ kể từ lượt sai đầu, không xóa khi cấp mã mới (xin mã mới không mở thêm lượt đoán).
    const codeFailKey = this.key('cfail', email, purpose);
    const codeAttempt = await this.redis.incr(codeFailKey);
    await this.redis.expire(codeFailKey, 3600, 'NX');
    if (codeAttempt > OTP.maxFailsPerHour) {
      await this.redis.del(codeKey);
      throw new AppException('OTP_INVALID');
    }

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
