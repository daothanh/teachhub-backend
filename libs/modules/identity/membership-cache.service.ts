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
 * Vai trò đang hoạt động của user cho MembershipGuard (§4.5), cache Redis theo `mv` của access token:
 * token mới (sau đổi vai trò + làm mới) mang `mv` mới → khóa mới → tự vô hiệu. Request đổi vai trò xóa khóa
 * của token đang dùng để thấy ngay. Thiết bị khác còn token cũ: cũ tối đa TTL 5 phút.
 */
@Injectable()
export class MembershipCache {
  private readonly log = new Logger(MembershipCache.name);

  constructor(
    private readonly tx: TxService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private key(ctx: RequestContext) {
    return `mbr:${ctx.userId}:${ctx.membershipsVersion ?? 0}`;
  }

  async active(ctx: RequestContext): Promise<ActiveMembership[]> {
    const key = this.key(ctx);
    const hit = await this.redis.get(key).catch(() => null);
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
    // Redis lỗi không chặn request: lần sau đọc CSDL lại.
    await this.redis
      .set(key, JSON.stringify(rows), 'EX', TTL_SEC)
      .catch((e: unknown) =>
        this.log.warn(`không ghi được cache ${key}: ${String(e)}`),
      );
    return rows;
  }

  async invalidate(ctx: RequestContext): Promise<void> {
    await this.redis.del(this.key(ctx)).catch(() => undefined);
  }
}
