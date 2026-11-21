import { createHash, createHmac, randomBytes } from 'node:crypto';

// Sinh và băm bí mật của lời mời. Hàm thuần (chỉ node:crypto), không phụ thuộc NestJS/Drizzle.

/** Crockford base32: không có `I L O U`. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHORT_CODE_LENGTH = 8;

/** Token 256-bit, base64url (43 ký tự). */
export const generateToken = (): string =>
  randomBytes(32).toString('base64url');

/**
 * Mã ngắn bằng CSPRNG và rejection sampling: byte >= `256 - 256 % 32` bị bỏ để không lệch phân phối
 * (với 32 ký tự giới hạn là 256 nên không byte nào bị bỏ, nhưng giữ vòng lặp để đúng nếu đổi bảng chữ).
 */
export function generateShortCode(
  bytes: (n: number) => Buffer = randomBytes,
): string {
  const limit = 256 - (256 % CROCKFORD.length);
  let out = '';
  while (out.length < SHORT_CODE_LENGTH) {
    for (const b of bytes(SHORT_CODE_LENGTH * 2)) {
      if (b < limit && out.length < SHORT_CODE_LENGTH) {
        out += CROCKFORD[b % CROCKFORD.length];
      }
    }
  }
  return out;
}

/** Chữ hoa; `I`/`L` → `1`, `O` → `0` (Crockford). */
export const normalizeShortCode = (code: string): string =>
  code.trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const hashShortCode = (code: string, key: string): string =>
  createHmac('sha256', key).update(normalizeShortCode(code)).digest('hex');
