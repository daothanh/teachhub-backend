import { maskAccountNo } from './payout-account.js';

describe('maskAccountNo', () => {
  it('chỉ giữ 4 số cuối', () => {
    expect(maskAccountNo('0123456789')).toBe('******6789');
    expect(maskAccountNo('123456')).toBe('**3456');
  });

  it('số tài khoản ngắn hơn 4 ký tự không bị cắt thêm', () => {
    expect(maskAccountNo('123')).toBe('123');
  });
});
