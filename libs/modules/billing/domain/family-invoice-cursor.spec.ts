import { describe, expect, it } from 'vitest';
import {
  decodeInvoiceCursor,
  encodeInvoiceCursor,
} from './family-invoice-cursor.js';

const AT = '2027-01-02T02:00:00.123456Z';
const ID = '019c0a10-0001-7b30-8c01-000000000001';
const raw = (s: string) => Buffer.from(s).toString('base64url');

describe('family invoice cursor', () => {
  it('khứ hồi và bỏ trống = trang đầu', () => {
    expect(decodeInvoiceCursor(encodeInvoiceCursor(AT, ID))).toEqual([AT, ID]);
    expect(decodeInvoiceCursor(undefined)).toBeNull();
  });

  it.each([
    ['rác', 'zzz'],
    ['thiếu id', raw(AT)],
    ['thừa phần', raw(`${AT}|${ID}|x`)],
    ['giờ không đủ µs', raw(`2027-01-02T02:00:00Z|${ID}`)],
    ['id sai', raw(`${AT}|not-a-uuid`)],
    ['ngày không có thật', raw(`2027-13-45T02:00:00.123456Z|${ID}`)],
  ])('%s → 422', (_n, c) => {
    expect(() => decodeInvoiceCursor(c)).toThrow();
  });
});
