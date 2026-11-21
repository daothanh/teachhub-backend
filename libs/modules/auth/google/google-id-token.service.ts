import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify } from 'jose';
import { AppException, type Env } from '@teachhub/core';
import {
  isEmailVerified,
  mapIdTokenError,
  remoteKeys,
} from '../jwks/id-token.util.js';

export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string | null;
  /** Google có thẩm quyền với email này (Gmail hoặc tên miền Workspace) → được gộp vào user cùng email. */
  emailAuthoritative: boolean;
}

const GMAIL = ['gmail.com', 'googlemail.com'];

// Hai dạng `iss` Google dùng cho id_token.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Xác minh id_token Google Sign-In: chữ ký RS256 theo JWKS của Google (cache 10 phút), `aud` là một trong
 * các client ID của TeachHub, `iss`, hạn; chỉ nhận email đã xác minh (để gộp vào user có cùng email).
 */
@Injectable()
export class GoogleIdTokenService {
  private readonly audiences: string[];
  private readonly keys: ReturnType<typeof remoteKeys>;

  constructor(config: ConfigService<Env, true>) {
    this.audiences = config.get('GOOGLE_CLIENT_IDS');
    this.keys = remoteKeys(config.get('GOOGLE_JWKS_URL'));
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (this.audiences.length === 0) throw new AppException('UNAUTHENTICATED');
    try {
      const { payload } = await jwtVerify(idToken, this.keys, {
        algorithms: ['RS256'],
        issuer: ISSUERS,
        audience: this.audiences,
        requiredClaims: ['sub', 'exp'],
      });
      const email =
        typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
      if (!email || !isEmailVerified(payload.email_verified)) {
        throw new AppException('UNAUTHENTICATED');
      }
      const domain = email.split('@').pop()!;
      return {
        subject: payload.sub!,
        email,
        name: typeof payload.name === 'string' ? payload.name : null,
        emailAuthoritative:
          GMAIL.includes(domain) ||
          (typeof payload.hd === 'string' &&
            payload.hd.toLowerCase() === domain),
      };
    } catch (e) {
      throw mapIdTokenError(e);
    }
  }
}
