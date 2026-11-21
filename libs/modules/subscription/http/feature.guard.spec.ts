import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AppException } from '@teachhub/core';
import type { TxService } from '@teachhub/db';
import type { PlanService } from '../application/plan.service.js';
import { FeatureGuard, RequiresFeature } from './feature.guard.js';

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

class Probe {
  @RequiresFeature('compliance.form02')
  pro() {}
  open() {}
}

const run = (
  handler: () => void,
  ctx: object | undefined,
  has: boolean,
): Promise<boolean> => {
  const plans = { hasFeature: vi.fn().mockResolvedValue(has) };
  const tx = { run: (_c: unknown, fn: (t: unknown) => unknown) => fn({}) };
  const guard = new FeatureGuard(
    new Reflector(),
    tx as unknown as TxService,
    plans as unknown as PlanService,
  );
  return guard.canActivate({
    getHandler: () => handler,
    getClass: () => Probe,
    switchToHttp: () => ({ getRequest: () => ({ ctx }) }),
  } as never);
};

const tenantCtx = {
  requestId: 'r',
  userId: 'u',
  sessionId: null,
  tenantId: 't',
};

describe('FeatureGuard', () => {
  it('route không gắn @RequiresFeature: cho qua, không hỏi gói', async () => {
    await expect(run(Probe.prototype.open, tenantCtx, false)).resolves.toBe(
      true,
    );
  });

  it('có cờ → cho qua', async () => {
    await expect(run(Probe.prototype.pro, tenantCtx, true)).resolves.toBe(true);
  });

  it('không có cờ → 402 FEATURE_REQUIRES_PRO kèm feature', async () => {
    const e = await run(Probe.prototype.pro, tenantCtx, false).catch((x) => x);
    expect(e).toBeInstanceOf(AppException);
    expect(e).toMatchObject({
      code: 'FEATURE_REQUIRES_PRO',
      details: { feature: 'compliance.form02' },
    });
  });

  it('thiếu tenant (quên @RequiresRole) → từ chối, không cho qua', async () => {
    const e = await run(
      Probe.prototype.pro,
      { ...tenantCtx, tenantId: null },
      true,
    ).catch((x) => x);
    expect(e).toMatchObject({ code: 'FORBIDDEN' });
  });
});
