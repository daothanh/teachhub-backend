import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { AppException, type Env } from '@teachhub/core';

export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string | null;
}

// Hai dạng `iss` Google dùng cho id_token.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Xác minh id_token Google Sign-In: chữ ký RS256 theo JWKS của Google (cache 10 phút), `aud` là một trong
 * các client ID của TeachHub, `iss`, hạn; chỉ nhận email đã xác minh (để gộp vào user có cùng email).
 */
@Injectable()
export class GoogleIdTokenService {
  private readonly audiences: string[];
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService<Env, true>) {
    this.audiences = config.get('GOOGLE_CLIENT_IDS');
    this.keys = createRemoteJWKSet(new URL(config.get('GOOGLE_JWKS_URL')));
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
      // Một số id_token cũ trả email_verified dạng chuỗi.
      const verified =
        payload.email_verified === true || payload.email_verified === 'true';
      if (!email || !verified) {
        throw new AppException('UNAUTHENTICATED');
      }
      return {
        subject: payload.sub!,
        email,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch (e) {
      if (e instanceof AppException) throw e;
      // Không lấy được khóa của Google ≠ token sai.
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
