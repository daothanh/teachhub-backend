import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { RequestContext } from '@teachhub/core';
import { memberships, TxService } from '@teachhub/db';
import { REDIS } from '@teachhub/infra';

export interface ActiveMembership {
  role: string;
  tenantId: string | null;
  studentId: string | null;
}

const TTL_SEC = 300;

/**
 * Vai trò đang hoạt động của user cho MembershipGuard (§4.5), cache Redis khóa `mbr:{user}:{gen}:{mv}`:
 * - `mv` của access token: token mới sau đổi vai trò → khóa mới;
 * - `gen` đếm theo user: mọi thay đổi vai trò qua code gọi `invalidate()` → mọi thiết bị, mọi token cũ
 *   cùng mất cache ngay (thu hồi vai trò có hiệu lực tức thì).
 * Sửa tay trong CSDL (không qua code) chỉ hết hiệu lực sau TTL 5 phút; RLS vẫn đọc vai trò thật.
 */
@Injectable()
export class MembershipCache {
  private readonly log = new Logger(MembershipCache.name);

  constructor(
    private readonly tx: TxService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private async key(ctx: RequestContext): Promise<string | null> {
    const gen = await this.redis.get(`mbr:gen:${ctx.userId}`);
    return `mbr:${ctx.userId}:${gen ?? 0}:${ctx.membershipsVersion ?? 0}`;
  }

  async active(ctx: RequestContext): Promise<ActiveMembership[]> {
    // Redis lỗi → không cache, đọc CSDL (an toàn khi thu hồi).
    const key = await this.key(ctx).catch(() => null);
    const hit = key ? await this.redis.get(key).catch(() => null) : null;
    if (hit) return JSON.parse(hit) as ActiveMembership[];

    const userId = ctx.userId!;
    const rows = await this.tx.run({ userId }, (t) =>
      t
        .select({
          role: memberships.role,
          tenantId: memberships.tenantId,
          studentId: memberships.studentId,
        })
        .from(memberships)
        .where(
          and(eq(memberships.userId, userId), eq(memberships.status, 'active')),
        )
        .orderBy(asc(memberships.createdAt)),
    );
    if (!key) return rows;
    await this.redis
      .set(key, JSON.stringify(rows), 'EX', TTL_SEC)
      .catch((e: unknown) =>
        this.log.warn(`không ghi được cache ${key}: ${String(e)}`),
      );
    return rows;
  }

  /** Gọi sau mọi thay đổi vai trò của user (cấp, thu hồi, kích hoạt lại). */
  async invalidate(userId: string): Promise<void> {
    await this.redis.incr(`mbr:gen:${userId}`);
  }
}
