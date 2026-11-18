import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  jwtVerify,
  SignJWT,
} from 'jose';
import { AppException, type Env } from '@teachhub/core';

const ALG = 'ES256';
const ACCESS_TTL = '15m';

/** Claim của access token (Technical Spec §2.7): `sub`, `sid` (phiên), `mv` (phiên bản membership). */
export interface AccessClaims {
  userId: string;
  sessionId: string;
  membershipsVersion: number;
}

const pem = (v: string) => v.replace(/\\n/g, '\n');

/** Ký và xác minh access token ES256 có `kid`; công bố khóa công khai ở JWKS để xoay vòng khóa. */
@Injectable()
export class JwtKeysService {
  private readonly kid: string;
  private readonly signingKey: KeyObject;
  readonly jwks: JSONWebKeySet;
  private readonly verifyKeys: ReturnType<typeof createLocalJWKSet>;

  constructor(config: ConfigService<Env, true>) {
    this.kid = config.get('JWT_KID');
    const raw = config.get('JWT_PRIVATE_KEY', { infer: true });
    // shortcut: local/test không cấu hình khóa → khóa tạm, token mất hiệu lực khi khởi động lại.
    this.signingKey = raw
      ? createPrivateKey(pem(raw))
      : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    if (this.signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('JWT_PRIVATE_KEY phải là khóa EC P-256 (ES256)');
    }

    const keys = [{ kid: this.kid, key: createPublicKey(this.signingKey) }];
    const prev = config.get('JWT_PREVIOUS_PUBLIC_KEY', { infer: true });
    const prevKid = config.get('JWT_PREVIOUS_KID', { infer: true });
    if (prev && prevKid) {
      keys.push({ kid: prevKid, key: createPublicKey(pem(prev)) });
    }
    this.jwks = {
      keys: keys.map(({ kid, key }) => ({
        ...key.export({ format: 'jwk' }),
        kid,
        alg: ALG,
        use: 'sig',
      })),
    };
    this.verifyKeys = createLocalJWKSet(this.jwks);
  }

  sign(c: AccessClaims): Promise<string> {
    return new SignJWT({ sid: c.sessionId, mv: c.membershipsVersion })
      .setProtectedHeader({ alg: ALG, kid: this.kid, typ: 'JWT' })
      .setSubject(c.userId)
      .setIssuedAt()
      .setExpirationTime(ACCESS_TTL)
      .sign(this.signingKey);
  }

  /** Hết hạn → `TOKEN_EXPIRED` (client tự làm mới); mọi lỗi khác → `UNAUTHENTICATED`. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.verifyKeys, {
        algorithms: [ALG],
        requiredClaims: ['sub', 'sid', 'mv', 'exp'],
      });
      if (typeof payload.sid !== 'string' || typeof payload.mv !== 'number') {
        throw new AppException('UNAUTHENTICATED');
      }
      return {
        userId: payload.sub!,
        sessionId: payload.sid,
        membershipsVersion: payload.mv,
      };
    } catch (e) {
      if (e instanceof errors.JWTExpired)
        throw new AppException('TOKEN_EXPIRED');
      throw new AppException('UNAUTHENTICATED');
    }
  }
}
