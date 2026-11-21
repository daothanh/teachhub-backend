import { describe, expect, it } from 'vitest';
import { buildVietQrPayload, crc16 } from './vietqr.js';

/** Parse TLV phẳng: { tag: value }. */
const parseTlv = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
};

const ok = {
  bankBin: '970436',
  accountNo: '0011001234567',
  amount: 1_500_000,
  transferNote: 'TH 4F7K2Q',
};

// Giá trị mong đợi dựng tay từng trường (len = độ dài giá trị), CRC tính độc lập bằng script Python riêng.
const cases = [
  {
    name: 'Vietcombank',
    input: ok,
    // 38: 0010A000000727 (14) + 0127[0006970436 + 011300110012345 67 -> 27] (31) + 0208QRIBFTTA (12) = 57
    expected:
      '00020101021238570010A00000072701270006970436011300110012345670208QRIBFTTA5303704540715000005802VN62130809TH 4F7K2Q6304AC70',
  },
  {
    name: 'MB',
    input: {
      bankBin: '970422',
      accountNo: '0987654321',
      amount: 350000n,
      transferNote: 'TH A1B2C3',
    },
    expected:
      '00020101021238540010A00000072701240006970422011009876543210208QRIBFTTA530370454063500005802VN62130809TH A1B2C36304F713',
  },
  {
    name: 'Techcombank',
    input: {
      bankBin: '970407',
      accountNo: '19036789012345',
      amount: 2000,
      transferNote: 'TH 000001',
    },
    expected:
      '00020101021238580010A000000727012800069704070114190367890123450208QRIBFTTA5303704540420005802VN62130809TH 0000016304E536',
  },
];

describe('crc16', () => {
  it('test vector chuẩn CCITT-FALSE', () => {
    expect(crc16('123456789')).toBe('29B1');
  });
});

describe('buildVietQrPayload', () => {
  it.each(cases)('payload đầy đủ $name', ({ input, expected }) => {
    expect(buildVietQrPayload(input)).toBe(expected);
  });

  it.each(cases)('parse ngược $name: từng tag', ({ input, expected }) => {
    const t = parseTlv(expected);
    expect(t['00']).toBe('01');
    expect(t['01']).toBe('12');
    const m = parseTlv(t['38']!);
    expect(m['00']).toBe('A000000727');
    expect(parseTlv(m['01']!)).toEqual({
      '00': input.bankBin,
      '01': input.accountNo,
    });
    expect(m['02']).toBe('QRIBFTTA');
    expect(t['53']).toBe('704');
    expect(t['54']).toBe(String(input.amount));
    expect(t['58']).toBe('VN');
    expect(parseTlv(t['62']!)).toEqual({ '08': input.transferNote });
    expect(t['63']).toBe(expected.slice(-4));
    expect(crc16(expected.slice(0, -4))).toBe(t['63']);
  });

  it('chấp nhận biên: số tiền 1 và 100 tỷ, tài khoản 6 và 19 số', () => {
    expect(() => buildVietQrPayload({ ...ok, amount: 1 })).not.toThrow();
    expect(() =>
      buildVietQrPayload({ ...ok, amount: 100_000_000_000n }),
    ).not.toThrow();
    expect(() =>
      buildVietQrPayload({ ...ok, accountNo: '123456' }),
    ).not.toThrow();
    expect(() =>
      buildVietQrPayload({ ...ok, accountNo: '1'.repeat(19) }),
    ).not.toThrow();
  });

  it.each([
    ['BIN 5 số', { bankBin: '97043' }, /bankBin/],
    ['BIN 7 số', { bankBin: '9704360' }, /bankBin/],
    ['BIN có chữ', { bankBin: '97043a' }, /bankBin/],
    ['tài khoản 5 số', { accountNo: '12345' }, /accountNo/],
    ['tài khoản 20 số', { accountNo: '1'.repeat(20) }, /accountNo/],
    ['tài khoản có chữ', { accountNo: '12345a' }, /accountNo/],
    ['amount 0', { amount: 0 }, /amount/],
    ['amount âm', { amount: -1 }, /amount/],
    ['amount lẻ', { amount: 1.5 }, /amount/],
    ['amount NaN', { amount: Number.NaN }, /amount/],
    ['amount vượt 100 tỷ', { amount: 100_000_000_001n }, /amount/],
    ['note rỗng', { transferNote: '' }, /transferNote/],
    ['note chữ thường', { transferNote: 'th abc123' }, /transferNote/],
    ['note có dấu', { transferNote: 'TH ÂBC' }, /transferNote/],
    ['note dài 26 ký tự', { transferNote: 'A'.repeat(26) }, /transferNote/],
  ])('ném RangeError: %s', (_n, patch, msg) => {
    expect(() => buildVietQrPayload({ ...ok, ...patch })).toThrow(RangeError);
    expect(() => buildVietQrPayload({ ...ok, ...patch })).toThrow(msg);
  });
});
