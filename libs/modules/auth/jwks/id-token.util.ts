import { createRemoteJWKSet, errors } from 'jose';
import { AppException } from '@teachhub/core';

/** JWKS từ xa của nhà cung cấp SSO: cache 10 phút, timeout 5 giây (mặc định của jose). */
export const remoteKeys = (url: string) => createRemoteJWKSet(new URL(url));

/** Nhà cung cấp gửi `email_verified` dạng boolean hoặc chuỗi "true". */
export const isEmailVerified = (v: unknown) => v === true || v === 'true';

/**
 * Đổi lỗi của jose khi xác minh id_token thành AppException: không lấy được khóa (timeout, mạng, HTTP khác 200,
 * JWKS hỏng) → 503, không phải lỗi của token; lỗi chữ ký/claim → 401. Lỗi khác ném lại nguyên.
 */
export function mapIdTokenError(e: unknown): unknown {
  if (e instanceof AppException) return e;
  const keyFetchFailed =
    e instanceof errors.JWKSTimeout ||
    // fetch thất bại (DNS, cổng chết…) ném thẳng TypeError.
    e instanceof TypeError ||
    (e instanceof errors.JOSEError &&
      e.message.includes('JSON Web Key Set HTTP response'));
  if (keyFetchFailed) return new AppException('SERVICE_UNAVAILABLE');
  if (e instanceof errors.JOSEError) return new AppException('UNAUTHENTICATED');
  return e;
}
