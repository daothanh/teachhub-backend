import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AppException } from '@teachhub/core';
import { AdminGuard, RequiresAdminPermission } from './admin.guard.js';

// `@teachhub/core` đọc env khi nạp; unit test không chạm DB/Redis nên giá trị giả là đủ.
vi.hoisted(() =>
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://u:p@localhost:5432/x',
    REDIS_URL: 'redis://localhost:6379',
    S3_REGION: 'x',
    S3_ACCESS_KEY_ID: 'x',
    S3_SECRET_ACCESS_KEY: 'x',
    S3_BUCKET_PRIVATE: 'x',
  }),
);

const SECRET = 'bi-mat-bff-admin-test-0123';
class Probe {
  @RequiresAdminPermission('/teachhub/admin/bank-transfer')
  guarded() {}
  bare() {}
}

const check = (
  headers: Record<string, string>,
  handler: () => void = Probe.prototype.guarded,
  secret: string | null = SECRET,
) => {
  const guard = new AdminGuard(
    { get: () => secret ?? undefined } as never,
    new Reflector(),
  );
  try {
    return guard.canActivate({
      getHandler: () => handler,
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as never);
  } catch (e) {
    return (e as AppException).code;
  }
};
const ok = {
  'x-admin-secret': SECRET,
  'x-admin-user-id': 'iam-1',
  'x-admin-permissions': '/teachhub/admin/bank-transfer',
};

describe('AdminGuard', () => {
  it('đủ ba header đúng → cho qua', () => expect(check(ok)).toBe(true));
  it.each([
    ['thiếu secret', { ...ok, 'x-admin-secret': '' }],
    ['sai secret', { ...ok, 'x-admin-secret': 'sai-bi-mat-sai-bi-mat' }],
    ['thiếu user id', { ...ok, 'x-admin-user-id': ' ' }],
    ['user id quá dài', { ...ok, 'x-admin-user-id': 'a'.repeat(129) }],
  ])('%s → UNAUTHENTICATED', (_, h) =>
    expect(check(h)).toBe('UNAUTHENTICATED'),
  );
  it('chưa cấu hình ADMIN_API_SECRET → UNAUTHENTICATED (fail closed)', () =>
    expect(check(ok, Probe.prototype.guarded, null)).toBe('UNAUTHENTICATED'));
  it('quyền khác route, thiếu quyền, hoặc route không khai quyền → FORBIDDEN', () => {
    expect(
      check({ ...ok, 'x-admin-permissions': '/teachhub/admin/support' }),
    ).toBe('FORBIDDEN');
    expect(check({ ...ok, 'x-admin-permissions': '' })).toBe('FORBIDDEN');
    expect(check(ok, Probe.prototype.bare)).toBe('FORBIDDEN');
  });
});
