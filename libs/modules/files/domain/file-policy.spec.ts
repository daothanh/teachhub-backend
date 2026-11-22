import {
  extensionFor,
  normalizeMime,
  objectKeyOf,
  PURPOSE_POLICY,
} from './file-policy.js';

describe('chính sách tệp', () => {
  it('biên lai chỉ nhận JPEG/PNG/HEIC, không phân biệt hoa thường hay tham số', () => {
    expect(extensionFor('receipt', 'image/jpeg')).toBe('jpg');
    expect(extensionFor('receipt', 'IMAGE/PNG')).toBe('png');
    expect(extensionFor('receipt', 'image/heic; x=1')).toBe('heic');
    expect(extensionFor('receipt', 'application/pdf')).toBeNull();
    expect(extensionFor('receipt', 'image/svg+xml')).toBeNull();
    expect(extensionFor('receipt', 'text/html')).toBeNull();
  });

  it('trần biên lai 10 MB', () => {
    expect(PURPOSE_POLICY.receipt.maxBytes).toBe(10_000_000);
  });

  it('khóa đối tượng theo mẫu Spec và không chứa tên gốc', () => {
    const key = objectKeyOf({
      tenantId: 't',
      purpose: 'receipt',
      entityId: 'e',
      random: 'r',
      ext: 'jpg',
    });
    expect(key).toBe('t/receipts/e/r.jpg');
  });

  it('chuẩn hóa MIME', () => {
    expect(normalizeMime(' Image/JPEG ;q=1')).toBe('image/jpeg');
  });
});
