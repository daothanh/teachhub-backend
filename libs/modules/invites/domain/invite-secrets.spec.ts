import {
  CROCKFORD,
  generateShortCode,
  generateToken,
  hashShortCode,
  hashToken,
  normalizeShortCode,
} from './invite-secrets.js';

describe('bí mật lời mời', () => {
  it('token 256-bit base64url, không trùng', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it('mã ngắn: 8 ký tự Crockford, không có I L O U', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateShortCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });

  it('rejection sampling: byte >= giới hạn bị bỏ, không lệch phân phối', () => {
    // Bảng 32 ký tự → giới hạn 256, mọi byte hợp lệ; byte 255 → 'Z', byte 0 → '0'.
    expect(generateShortCode(() => Buffer.alloc(16, 255))).toBe('Z'.repeat(8));
    expect(generateShortCode(() => Buffer.alloc(16, 0))).toBe('0'.repeat(8));
    expect(CROCKFORD).toHaveLength(32);
  });

  it('chuẩn hóa Crockford và băm khóa hóa: I/L/O/hoa-thường cho cùng băm, khác khóa khác băm', () => {
    expect(normalizeShortCode(' 7k3qlO9m ')).toBe('7K3Q109M');
    expect(hashShortCode('7k3q1o9m', 'k'.repeat(16))).toBe(
      hashShortCode('7K3QL09M', 'k'.repeat(16)),
    );
    expect(hashShortCode('7K3Q109M', 'a'.repeat(16))).not.toBe(
      hashShortCode('7K3Q109M', 'b'.repeat(16)),
    );
    expect(hashToken('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
