import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
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

/**
 * Khoảng ân hạn sau một lần xoay: client gửi refresh, server xoay xong nhưng phản hồi rớt (timeout, mất mạng) thì
 * client chỉ còn token cũ. Gửi lại đúng token đó trong khoảng này → trả lại refresh token đã cấp ở lần xoay ấy thay vì
 * coi là dùng lại và thu hồi cả họ. 30 giây đủ cho một lần thử lại của app, đủ ngắn để kẻ trộm token cũ khó tận dụng.
 */
export const REFRESH_GRACE_SEC = 30;
export const refreshGraceKey = (oldToken: string) =>
  `refresh-grace:${hashRefreshToken(oldToken)}`;

export const hashRefreshToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

type Grace = { userId: string; refreshToken: string };
// Khóa mã hóa suy từ token cũ (thô): bản dump Redis hay CSDL (chỉ có băm) đều không mở được token mới.
const graceKey = (oldToken: string) =>
  createHash('sha256').update(`refresh-grace\0${oldToken}`).digest();
const sealGrace = (oldToken: string, g: Grace): string => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', graceKey(oldToken), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(g)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const openGrace = (oldToken: string, sealed: string): Grace => {
  const raw = Buffer.from(sealed, 'base64');
  const d = createDecipheriv(
    'aes-256-gcm',
    graceKey(oldToken),
    raw.subarray(0, 12),
    { authTagLength: 16 },
  );
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'),
  ) as Grace;
};

/** Phiên đăng nhập: mở (sau khi xác minh danh tính), làm mới (xoay vòng), đóng (đăng xuất). */
@Injectable()
export class SessionService {
  private readonly log = new Logger(SessionService.name);

  constructor(
    private readonly tx: TxService,
    private readonly jwt: JwtKeysService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Sau DELETE /me: access token cũ (≤ 15 phút) bị guard chặn. Chỉ là lớp phụ, TTL ngắn hơn refresh token; lớp chính là
   * kiểm `users.deleted_at` trong CSDL. Lỗi Redis không được làm hỏng lệnh xóa đã commit.
   */
  async markDeleted(userId: string): Promise<void> {
    try {
      await this.redis.set(deletedKey(userId), '1', 'EX', ACCESS_TTL_SEC + 60);
    } catch (e) {
      this.log.error(
        `không ghi được khóa tài khoản đã xóa: ${e instanceof Error ? e.name : 'lỗi'}`,
      );
    }
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
   * họ (phát hiện đánh cắp), trừ khi còn trong khoảng ân hạn `REFRESH_GRACE_SEC`. Mọi lỗi là `UNAUTHENTICATED` —
   * `TOKEN_EXPIRED` ở đây khiến client làm mới lặp.
   */
  async refresh(refreshToken: string): Promise<RefreshResponse> {
    const replay = await this.replayGrace(refreshToken);
    if (replay) return replay;
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
    try {
      await this.redis.set(
        refreshGraceKey(refreshToken),
        sealGrace(refreshToken, { userId, refreshToken: next }),
        'EX',
        REFRESH_GRACE_SEC,
      );
    } catch (e) {
      // Mất ân hạn chỉ làm lần gửi lại (nếu có) bị thu hồi như trước; không được làm hỏng lần xoay đã commit.
      this.log.error(
        `không ghi được ân hạn refresh: ${e instanceof Error ? e.name : 'lỗi'}`,
      );
    }
    return this.tokens(userId, sessionId, mv, next);
  }

  /**
   * Token vừa xoay trong `REFRESH_GRACE_SEC` → trả lại refresh token đã cấp (kèm access token mới), miễn token đó
   * vẫn sống: đã bị xoay tiếp, đăng xuất hay thu hồi thì rơi về đường thường (thu hồi cả họ). Mỗi khóa ân hạn chỉ
   * đổi được một lần (GETDEL): kẻ giữ token cũ chỉ có một lượt, lượt sau rơi về phát hiện dùng lại.
   * shortcut: hai request cùng token chạy song song trước khi khóa ân hạn kịp ghi vẫn bị coi là dùng lại; client
   * làm mới một luồng nên chấp nhận, cần chặt hơn thì ghi khóa ân hạn trong `rotate_refresh_token`.
   */
  private async replayGrace(
    refreshToken: string,
  ): Promise<RefreshResponse | null> {
    let g: Grace;
    try {
      const sealed = await this.redis.getdel(refreshGraceKey(refreshToken));
      if (!sealed) return null;
      g = openGrace(refreshToken, sealed);
    } catch (e) {
      this.log.error(
        `không đọc được ân hạn refresh: ${e instanceof Error ? e.name : 'lỗi'}`,
      );
      return null;
    }
    const live = await this.tx.run({ userId: g.userId }, async (t) => {
      const [row] = await t
        .select({ sessionId: refreshTokens.sessionId })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tokenHash, hashRefreshToken(g.refreshToken)),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, sql`now()`),
          ),
        );
      return row
        ? { sessionId: row.sessionId, mv: (await this.load(t, g.userId)).mv }
        : null;
    });
    if (!live) return null;
    return this.tokens(g.userId, live.sessionId, live.mv, g.refreshToken);
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
