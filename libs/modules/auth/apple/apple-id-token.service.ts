import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify } from 'jose';
import type { Redis } from 'ioredis';
import { AppException, type Env } from '@teachhub/core';
import { REDIS } from '@teachhub/infra';
import {
  isEmailVerified,
  mapIdTokenError,
  remoteKeys,
} from '../jwks/id-token.util.js';

export interface AppleIdentity {
  subject: string;
  email: string | null;
  /** Chỉ true khi Apple xác nhận email VÀ không phải địa chỉ relay → mới được gộp vào user có cùng email. */
  emailMergeable: boolean;
  /** Địa chỉ `@privaterelay.appleid.com`: duy nhất cho mỗi cặp (người dùng, app), không bao giờ gộp. */
  isPrivateRelay: boolean;
}

const ISSUER = 'https://appleid.apple.com';
const RELAY_DOMAIN = 'privaterelay.appleid.com';
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const replayKey = (idToken: string) => `apple:used:${sha256Hex(idToken)}`;
export const APPLE_ANDROID_SERVICES_ID = 'vn.dayhoc.app.web';

const sameClaim = (claim: unknown, expected: string): boolean => {
  if (typeof claim !== 'string') return false;
  const actual = Buffer.from(claim);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

/**
 * Xác minh identityToken của Sign in with Apple: chữ ký RS256/ES256 theo JWKS Apple (cache 10 phút, timeout 5 giây),
 * `iss`, `aud` = bundle ID, hạn, `nonce`; rồi chặn phát lại.
 *
 * Quy ước nonce (duy nhất): client sinh nonce thô, gửi **thô** lên server (`nonce` trong body) và gửi
 * SHA-256(nonce) dạng hex cho Apple. Apple chép giá trị băm vào claim `nonce`; server băm nonce thô rồi so với claim.
 */
@Injectable()
export class AppleIdTokenService {
  private readonly bundleIds: string[];
  private readonly keys: ReturnType<typeof remoteKeys>;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.bundleIds = config.get('APPLE_BUNDLE_ID');
    this.keys = remoteKeys(config.get('APPLE_JWKS_URL'));
  }

  /** Nhả khóa phát lại khi bước sau xác minh lỗi, để client gửi lại cùng token. Best-effort: khóa tự hết hạn theo `exp`. */
  async release(idToken: string): Promise<void> {
    await this.redis.del(replayKey(idToken)).catch(() => undefined);
  }

  verify(idToken: string, rawNonce: string): Promise<AppleIdentity> {
    return this.verifyToken(idToken, sha256Hex(rawNonce));
  }

  verifyAndroid(
    idToken: string,
    nonce: string,
    code: string,
  ): Promise<AppleIdentity> {
    return this.verifyToken(idToken, nonce, code);
  }

  private async verifyToken(
    idToken: string,
    nonce: string,
    authorizationCode?: string,
  ): Promise<AppleIdentity> {
    const android = authorizationCode !== undefined;
    if (!android && this.bundleIds.length === 0) {
      throw new AppException('UNAUTHENTICATED');
    }
    try {
      const { payload } = await jwtVerify(idToken, this.keys, {
        algorithms: ['RS256', 'ES256'],
        issuer: ISSUER,
        audience: android ? APPLE_ANDROID_SERVICES_ID : this.bundleIds,
        clockTolerance: '5s',
        requiredClaims: ['sub', 'exp'],
      });
      if (android) {
        // Cả RS256 và ES256 dùng SHA-256; c_hash là nửa đầu của digest.
        const codeHash = createHash('sha256')
          .update(authorizationCode)
          .digest()
          .subarray(0, 16)
          .toString('base64url');
        if (
          payload.aud !== APPLE_ANDROID_SERVICES_ID ||
          !sameClaim(payload.nonce, nonce) ||
          !sameClaim(payload.c_hash, codeHash) ||
          !payload.sub
        ) {
          throw new AppException('UNAUTHENTICATED');
        }
      } else if (
        [payload.aud].flat().includes(APPLE_ANDROID_SERVICES_ID) ||
        typeof payload.nonce !== 'string' ||
        !sameClaim(payload.nonce.toLowerCase(), nonce)
      ) {
        throw new AppException('UNAUTHENTICATED');
      }
      const ttl = Math.max(1, payload.exp! - Math.floor(Date.now() / 1000));
      const fresh = await this.redis
        .set(replayKey(idToken), '1', 'EX', ttl, 'NX')
        // Không kiểm được chống phát lại → đóng an toàn, không bỏ qua.
        .catch(() => {
          throw new AppException('SERVICE_UNAVAILABLE');
        });
      if (!fresh) {
        throw new AppException('UNAUTHENTICATED', { reason: 'TOKEN_REPLAYED' });
      }

      const email =
        typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
      const verified = isEmailVerified(payload.email_verified);
      const isPrivateRelay = !!email && email.endsWith(`@${RELAY_DOMAIN}`);
      return {
        subject: payload.sub!,
        email: android && !verified ? null : email,
        emailMergeable: !!email && verified && !isPrivateRelay,
        isPrivateRelay: isPrivateRelay && (!android || verified),
      };
    } catch (e) {
      throw mapIdTokenError(e);
    }
  }
}
