import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import { memberships, refreshTokens, TxService, users } from '@teachhub/db';
import type { LoginResponse, User } from '../http/auth.schemas.js';
import { JwtKeysService } from '../jwt/jwt-keys.service.js';

const ACCESS_TTL_SEC = 15 * 60;
/** Hạn trượt 30 ngày (D20); tối đa 90 ngày kiểm ở lúc làm mới (S1-BE-05). */
export const REFRESH_TTL_DAYS = 30;

export const hashRefreshToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** Mở phiên sau khi đã xác minh danh tính: refresh token mới (họ mới) + access token. */
@Injectable()
export class SessionService {
  constructor(
    private readonly tx: TxService,
    private readonly jwt: JwtKeysService,
  ) {}

  async open(userId: string): Promise<LoginResponse> {
    const refreshToken = randomBytes(32).toString('base64url');
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
      const [u] = await t
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          mv: users.membershipsVersion,
        })
        .from(users)
        .where(eq(users.id, userId));
      if (!u?.email) throw new Error(`user ${userId} không đọc được`);
      const roles = await t
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.userId, userId), eq(memberships.status, 'active')),
        );
      const user: User = {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        permissions: [...new Set(roles.map((r) => `role:${r.role}`))],
      };
      return { user, mv: u.mv };
    });
    return {
      access_token: await this.jwt.sign({
        userId,
        sessionId,
        membershipsVersion: mv,
      }),
      refresh_token: refreshToken,
      expires_in: ACCESS_TTL_SEC,
      user,
    };
  }
}
