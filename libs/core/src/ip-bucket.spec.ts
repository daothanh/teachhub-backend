import { ipBucket } from './ip-bucket.js';

describe('ipBucket', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['rác', 'unknown'],
    [undefined, 'unknown'],
  ])('%s → %s', (ip, want) => {
    expect(ipBucket(ip)).toBe(want);
  });

  it('hai địa chỉ cùng /64 chung một khóa, khác /64 thì khác', () => {
    expect(ipBucket('2001:db8:1:2::a')).toBe(ipBucket('2001:db8:1:2:9::b'));
    expect(ipBucket('2001:db8:1:2::a')).not.toBe(ipBucket('2001:db8:1:3::a'));
  });
});
