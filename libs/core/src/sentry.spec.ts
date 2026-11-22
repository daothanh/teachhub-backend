import type { Event } from '@sentry/nestjs';
import { scrubEvent, scrubText } from './sentry.js';

describe('scrubEvent (Sentry beforeSend)', () => {
  const dirty: Event = {
    message: 'lỗi gửi cho a.b+c@gmail.com và 0912 345 678',
    request: {
      url: 'https://api.example.com/v1/students?phone=0912345678&q=x',
      method: 'POST',
      data: { fullName: 'Nguyen Van A', phone: '0912345678' },
      cookies: { sid: 'abc' },
      query_string: 'phone=0912345678',
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'sid=abc',
        'X-Admin-Secret': 's',
        'Idempotency-Key': 'k',
        'X-RevenueCat-Signature': 'r',
        'User-Agent': 'ua',
        'X-Request-Id': 'rid',
      },
    },
    user: { id: 'u1', email: 'a@b.vn', ip_address: '1.2.3.4', username: 'a' },
    extra: { note: 'liên hệ +84 912.345.678', nested: { e: 'x@y.com' } },
    exception: { values: [{ type: 'Error', value: 'bad x@y.com' }] },
    breadcrumbs: [
      { category: 'http', message: 'POST /x', data: { body: 'secret' } },
      { category: 'console', message: 'mail x@y.com' },
    ],
  };

  it('đầu ra không còn body, cookie, query, header nhạy cảm, PII', () => {
    const out = scrubEvent(structuredClone(dirty));
    expect(out.request).toEqual({
      url: 'https://api.example.com/v1/students',
      method: 'POST',
      headers: { 'User-Agent': 'ua', 'X-Request-Id': 'rid' },
    });
    expect(out.user).toEqual({ id: 'u1' });
    expect(out.breadcrumbs?.[0]?.data).toBeUndefined();
    const json = JSON.stringify(out);
    for (const leak of [
      '@',
      '0912',
      '912.345',
      'Nguyen',
      'secret',
      'sid=',
      '1.2.3.4',
    ])
      expect(json).not.toContain(leak);
  });

  it('bỏ user khi không có id; scrubText chỉ che email/SĐT', () => {
    expect(scrubEvent({ user: { email: 'a@b.vn' } }).user).toBeUndefined();
    expect(scrubText('job 2026-11-22 10:20 id 123456789')).toBe(
      'job 2026-11-22 10:20 id 123456789',
    );
  });
});
