import {
  extensionFor,
  matchesMagic,
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

  it('magic bytes khớp MIME khai', () => {
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const heic = Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypheic')]);
    const html = Uint8Array.from(Buffer.from('<html><script>alert(1)'));
    expect(matchesMagic('image/jpeg', jpg)).toBe(true);
    expect(matchesMagic('image/png', png)).toBe(true);
    expect(matchesMagic('image/heic', heic)).toBe(true);
    expect(matchesMagic('image/jpeg', png)).toBe(false);
    expect(matchesMagic('image/png', html)).toBe(false);
    expect(matchesMagic('image/heic', jpg)).toBe(false);
    expect(matchesMagic('image/jpeg', new Uint8Array())).toBe(false);
    expect(matchesMagic('application/pdf', jpg)).toBe(false);
  });
});
