import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppException, ipBucket } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { REDIS } from '@teachhub/infra';

export type AttemptScope = 'accept' | 'preview';

const WINDOW_SEC = 15 * 60;
/**
 * Ngưỡng lần thử SAI trong 15 phút. User: 5 (US-0.12 AC5). IP cao hơn vì một IP có thể là wifi chung của cả trường.
 * Bộ đếm toàn cục chặn dò mã ngắn phân tán nhiều IP/tài khoản và CHỈ áp cho đổi mã ngắn (không gian 2^40); token
 * 32 byte không đoán được nên không đếm toàn cục. Vượt trần toàn cục chỉ chặn user/IP đã sai ít nhất một lần trong
 * cửa sổ: kẻ dò không khóa được người nhập mã lần đầu (DoS).
 */
const LIMITS = {
  accept: { user: 5, ip: 20, global: 500 },
  preview: { user: Infinity, ip: 20, global: Infinity },
} as const;

/**
 * Giữ chỗ một lần thử: INCR nguyên tử rồi mới so ngưỡng, nên request song song không vượt được ngưỡng.
 * Thành công / không phải lỗi sai mã thì `release` hoàn lại; lỗi 410 thì giữ nguyên (= đã đếm một lần sai).
 */
export interface AttemptReservation {
  keys: string[];
}

// KEYS = các bộ đếm; ARGV[1] = TTL, ARGV[2..n+1] = ngưỡng theo từng khóa, ARGV[n+2] = vị trí khóa toàn cục (0 = không
// có; luôn là khóa cuối). Khóa toàn cục vượt ngưỡng chỉ chặn khi khóa user/IP trước nó đã có lần sai (đếm > 1 sau INCR).
// Trả [đếm, pttl, chặn] cho từng khóa. Có khóa chặn thì hoàn lại các khóa không chặn (người bị khóa không đốt bộ đếm khác).
const RESERVE = `
local n, out, over, prior = #KEYS, {}, false, false
local g = tonumber(ARGV[n + 2])
for i, k in ipairs(KEYS) do
  local c = redis.call('INCR', k)
  if c == 1 then redis.call('EXPIRE', k, ARGV[1]) end
  local hit = c > tonumber(ARGV[i + 1])
  if i == g then hit = hit and prior elseif c > 1 then prior = true end
  out[#out + 1] = c
  out[#out + 1] = redis.call('PTTL', k)
  out[#out + 1] = hit and 1 or 0
  if hit then over = true end
end
if over then
  for i, k in ipairs(KEYS) do
    if out[3 * i] == 0 then redis.call('DECR', k) end
  end
end
return out`;

const RELEASE = `
for _, k in ipairs(KEYS) do
  local c = redis.call('DECR', k)
  if c <= 0 then redis.call('DEL', k) end
end
return 1`;

/**
 * Bộ đếm lần sai nhận lời mời trong Redis, ba lớp (user, IP /64, toàn cục cho mã ngắn). 422 sai định dạng, phát
 * lại phản hồi đã lưu và lỗi hệ thống không bị đếm (xem `InviteAcceptanceService`).
 */
@Injectable()
export class InviteAttemptLimiter {
  private readonly log = new Logger(InviteAttemptLimiter.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tx: TxService,
  ) {}

  /**
   * Giữ chỗ một lần thử TRƯỚC khi tra mã; vượt ngưỡng thì 429 kể cả khi lần này nhập đúng.
   * `global`: có áp bộ đếm toàn cục không (chỉ đổi mã ngắn).
   * Redis lỗi → từ chối (fail closed): không có bộ đếm thì không cho dò mã.
   */
  async reserve(
    scope: AttemptScope,
    userId: string | null,
    ip: string,
    global = false,
  ): Promise<AttemptReservation> {
    const lim = LIMITS[scope];
    const layers: {
      layer: 'user' | 'ip' | 'global';
      key: string;
      max: number;
    }[] = [];
    if (userId && Number.isFinite(lim.user)) {
      layers.push({
        layer: 'user',
        key: `inv:f:${scope}:u:${userId}`,
        max: lim.user,
      });
    }
    layers.push({
      layer: 'ip',
      key: `inv:f:${scope}:ip:${ipBucket(ip)}`,
      max: lim.ip,
    });
    if (global && Number.isFinite(lim.global)) {
      layers.push({
        layer: 'global',
        key: `inv:f:${scope}:g`,
        max: lim.global,
      });
    }
    let res: number[];
    try {
      res = (await this.redis.eval(
        RESERVE,
        layers.length,
        ...layers.map((l) => l.key),
        WINDOW_SEC,
        ...layers.map((l) => l.max),
        layers.at(-1)!.layer === 'global' ? layers.length : 0,
      )) as number[];
    } catch (e) {
      this.log.error(
        `Redis lỗi, từ chối lượt thử lời mời: ${(e as Error).message}`,
      );
      throw new AppException('RATE_LIMITED', { retryAfterSec: 30 });
    }
    const hits = layers
      .map((l, i) => ({
        ...l,
        count: Number(res[3 * i]),
        pttl: Number(res[3 * i + 1]),
        hit: Number(res[3 * i + 2]) === 1,
      }))
      .filter((l) => l.hit);
    if (hits.length === 0) return { keys: layers.map((l) => l.key) };
    for (const h of hits) {
      // Audit đúng một lần, ở lượt đầu tiên bị từ chối của lớp đó (lớp toàn cục: chỉ khi lượt vượt trần đầu tiên bị chặn).
      if (h.count === h.max + 1) await this.auditLock(scope, userId, h.layer);
      if (h.layer === 'global') {
        // shortcut: vượt trần toàn cục chỉ chặn user/IP đã sai trong cửa sổ, kẻ dò dùng nhiều tài khoản + IP mới vẫn được
        // một lượt mỗi cặp; cần CAPTCHA/chống bot khi bị dò thật, chưa có.
        this.log.warn(
          `Bộ đếm toàn cục đổi mã mời chạm ngưỡng (${h.count}/${h.max})`,
        );
      }
    }
    const first = hits[0]!;
    const retryAfterSec = Math.max(Math.ceil(first.pttl / 1000), 1);
    const code =
      first.layer === 'user' || (first.layer === 'ip' && scope === 'accept')
        ? 'INVITE_CODE_LOCKED'
        : 'RATE_LIMITED';
    throw new AppException(code, { retryAfterSec });
  }

  /** Hoàn lại lượt đã giữ (thành công, phát lại, hoặc lỗi không phải sai mã). */
  async release(r: AttemptReservation): Promise<void> {
    try {
      await this.redis.eval(RELEASE, r.keys.length, ...r.keys);
    } catch (e) {
      // Không hoàn được thì lượt này tính như một lần sai: lệch về phía an toàn.
      this.log.warn(`Không hoàn được bộ đếm: ${(e as Error).message}`);
    }
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
