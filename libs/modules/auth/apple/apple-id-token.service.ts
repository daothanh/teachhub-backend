import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { Redis } from 'ioredis';
import { AppException, type Env } from '@teachhub/core';
import { REDIS } from '@teachhub/infra';

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

/**
 * Xác minh identityToken của Sign in with Apple: chữ ký RS256/ES256 theo JWKS Apple (cache 10 phút, timeout 5 giây),
 * `iss`, `aud` = bundle ID, hạn, `nonce`; rồi chặn phát lại.
 *
 * Quy ước nonce (duy nhất): client sinh nonce thô, gửi **thô** lên server (`nonce` trong body) và gửi
 * SHA-256(nonce) dạng hex cho Apple. Apple chép giá trị băm vào claim `nonce`; server băm nonce thô rồi so với claim.
 */
@Injectable()
export class AppleIdTokenService {
  private readonly bundleId: string;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.bundleId = config.get('APPLE_BUNDLE_ID');
    this.keys = createRemoteJWKSet(new URL(config.get('APPLE_JWKS_URL')), {
      timeoutDuration: 5_000,
      cacheMaxAge: 600_000,
    });
  }

  async verify(idToken: string, rawNonce: string): Promise<AppleIdentity> {
    if (!this.bundleId) throw new AppException('UNAUTHENTICATED');
    try {
      const { payload } = await jwtVerify(idToken, this.keys, {
        algorithms: ['RS256', 'ES256'],
        issuer: ISSUER,
        audience: this.bundleId,
        requiredClaims: ['sub', 'exp'],
      });
      if (
        typeof payload.nonce !== 'string' ||
        payload.nonce.toLowerCase() !== sha256Hex(rawNonce)
      ) {
        throw new AppException('UNAUTHENTICATED');
      }
      // shortcut: Redis lỗi → 500 (đóng an toàn, không bỏ qua chống phát lại); client gửi lại cùng token sau khi
      // mạng đứt sẽ bị 401, phải xin token Apple mới.
      const ttl = Math.max(1, payload.exp! - Math.floor(Date.now() / 1000));
      const fresh = await this.redis.set(
        `apple:used:${sha256Hex(idToken)}`,
        '1',
        'EX',
        ttl,
        'NX',
      );
      if (!fresh) {
        throw new AppException('UNAUTHENTICATED', { reason: 'TOKEN_REPLAYED' });
      }

      const email =
        typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
      // Apple gửi email_verified dạng boolean hoặc chuỗi "true".
      const verified =
        payload.email_verified === true || payload.email_verified === 'true';
      const isPrivateRelay = !!email && email.endsWith(`@${RELAY_DOMAIN}`);
      return {
        subject: payload.sub!,
        email,
        emailMergeable: !!email && verified && !isPrivateRelay,
        isPrivateRelay,
      };
    } catch (e) {
      if (e instanceof AppException) throw e;
      // Không lấy được khóa của Apple ≠ token sai.
      if (e instanceof errors.JWKSTimeout) {
        throw new AppException('SERVICE_UNAVAILABLE');
      }
      if (e instanceof errors.JOSEError) {
        throw new AppException('UNAUTHENTICATED');
      }
      throw e;
    }
  }
}
