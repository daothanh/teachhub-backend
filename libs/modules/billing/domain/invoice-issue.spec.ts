import { describe, expect, it } from 'vitest';
import { generateInvoiceCode, transferNoteOf } from './invoice-issue.js';
import { buildVietQrPayload } from './vietqr.js';

describe('mã hóa đơn và nội dung chuyển khoản', () => {
  it('mã đúng định dạng TH-XXXXXX, chỉ ký tự Crockford', () => {
    for (let i = 0; i < 500; i++)
      expect(generateInvoiceCode()).toMatch(/^TH-[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  it('nội dung chuyển khoản TH XXXXXX, ≤ 25 ký tự và VietQR chấp nhận', () => {
    const note = transferNoteOf('TH-25K7Q9');
    expect(note).toBe('TH 25K7Q9');
    expect(note.length).toBeLessThanOrEqual(25);
    expect(
      buildVietQrPayload({
        bankBin: '970436',
        accountNo: '0011223344',
        amount: 1_200_000,
        transferNote: note,
      }),
    ).toContain('TH 25K7Q9');
  });

  it('pick quyết định ký tự (tất định khi tiêm)', () => {
    expect(generateInvoiceCode(() => 0)).toBe('TH-000000');
    expect(generateInvoiceCode((m) => m - 1)).toBe('TH-ZZZZZZ');
  });
});
