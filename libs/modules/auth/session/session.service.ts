import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import {
  memberships,
  refreshTokens,
  type Tx,
  TxService,
  users,
} from '@teachhub/db';
import { REDIS } from '@teachhub/infra';
import type {
  LoginResponse,
  RefreshResponse,
  User,
} from '../http/auth.schemas.js';
import { JwtKeysService } from '../jwt/jwt-keys.service.js';

const ACCESS_TTL_SEC = 15 * 60;
/** Khóa Redis đánh dấu tài khoản đã xóa; guard từ chối mọi access token của user này tới khi token hết hạn. */
export const deletedKey = (userId: string) => `deleted:${userId}`;
/** Hạn trượt 30 ngày; tối đa 90 ngày kiểm trong app_private.rotate_refresh_token (D20). */
export const REFRESH_TTL_DAYS = 30;

export const hashRefreshToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

/** Phiên đăng nhập: mở (sau khi xác minh danh tính), làm mới (xoay vòng), đóng (đăng xuất). */
@Injectable()
export class SessionService {
  constructor(
    private readonly tx: TxService,
    private readonly jwt: JwtKeysService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Sau DELETE /me: token cũ (≤ 15 phút) không dùng được nữa. */
  async markDeleted(userId: string): Promise<void> {
    await this.redis.set(deletedKey(userId), '1', 'EX', ACCESS_TTL_SEC + 60);
  }

  async open(userId: string): Promise<LoginResponse> {
    const refreshToken = newRefreshToken();
    const sessionId = uuidv7();
    const { user, mv } = await this.tx.run({ userId }, async (t) => {
      await t.insert(refreshTokens).values({
        id: uuidv7(),
        userId,
        sessionId,
        familyId: uuidv7(),
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: sql`now() + make_interval(days => ${REFRESH_TTL_DAYS})`,
      });
      return this.load(t, userId);
    });
    return {
      ...(await this.tokens(userId, sessionId, mv, refreshToken)),
      user,
    };
  }

  /**
   * Đổi refresh token lấy cặp token mới; token cũ bị thu hồi. Token đã xoay mà bị dùng lại → thu hồi cả
   * họ (phát hiện đánh cắp). Mọi lỗi là `UNAUTHENTICATED` — `TOKEN_EXPIRED` ở đây khiến client làm mới lặp.
   */
  async refresh(refreshToken: string): Promise<RefreshResponse> {
    const next = newRefreshToken();
    const row = await this.tx.run({ userId: null }, async (t) => {
      const { rows } = await t.execute<{
        status: string;
        user_id: string | null;
        session_id: string | null;
      }>(
        sql`select * from app_private.rotate_refresh_token(${hashRefreshToken(refreshToken)}, ${uuidv7()}, ${hashRefreshToken(next)})`,
      );
      return rows[0];
    });
    if (row?.status !== 'ok' || !row.user_id || !row.session_id) {
      throw new AppException('UNAUTHENTICATED');
    }
    const { user_id: userId, session_id: sessionId } = row;
    const mv = await this.tx.run({ userId }, (t) =>
      this.load(t, userId).then((r) => r.mv),
    );
    return this.tokens(userId, sessionId, mv, next);
  }

  /** Đăng xuất: thu hồi mọi refresh token của phiên hiện tại (access token tự hết hạn ≤ 15 phút). */
  async close(userId: string, sessionId: string): Promise<void> {
    await this.tx.run({ userId }, (t) =>
      t
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.sessionId, sessionId),
            isNull(refreshTokens.revokedAt),
          ),
        ),
    );
  }

  user(userId: string): Promise<User> {
    return this.tx.run({ userId }, (t) =>
      this.load(t, userId).then((r) => r.user),
    );
  }

  private async tokens(
    userId: string,
    sessionId: string,
    mv: number,
    refreshToken: string,
  ): Promise<RefreshResponse> {
    return {
      access_token: await this.jwt.sign({
        userId,
        sessionId,
        membershipsVersion: mv,
      }),
      refresh_token: refreshToken,
      expires_in: ACCESS_TTL_SEC,
    };
  }

  /** User + quyền `role:<vai trò>` (dạng tasco_auth đọc) — trong giao dịch có app.user_id = userId. */
  private async load(
    t: Tx,
    userId: string,
  ): Promise<{ user: User; mv: number }> {
    const [u] = await t
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        mv: users.membershipsVersion,
      })
      .from(users)
      .where(eq(users.id, userId));
    // User trong token nhưng không còn đọc được (đã xóa) → coi như chưa đăng nhập.
    if (!u?.email) throw new AppException('UNAUTHENTICATED');
    const roles = await t
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(eq(memberships.userId, userId), eq(memberships.status, 'active')),
      );
    return {
      user: {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        permissions: [...new Set(roles.map((r) => `role:${r.role}`))],
      },
      mv: u.mv,
    };
  }
}
