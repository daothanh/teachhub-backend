import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S7 subscription (phần còn lại sau #194): FeatureGuard, job subscription.lifecycle, admin xác nhận chuyển khoản
// (US-0.7 AC4, US-0.8 AC3, AC4, AC5).
describe('subscription: vòng đời gói', () => {
  let t: TestApp;
  // Nạp sau khi đặt env (module `core` đọc env lúc nạp).
  let sub: typeof import('../libs/modules/subscription/index.js');

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const mk = async (plan: 'free' | 'pro' = 'free'): Promise<Who> => {
    const s = await seedTenant(t.worker, plan);
    return { ...s, token: await t.tokenFor(s.userId) };
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      PRO_PRICE_VND: '250000',
      PAYEE_BANK_BIN: '970436',
      PAYEE_BANK_NAME: 'Vietcombank',
      PAYEE_ACCOUNT_NO: '0011004123456',
      PAYEE_ACCOUNT_NAME: 'CONG TY TEACHHUB',
    });
    t = await startTestApp();
    sub = await import('../libs/modules/subscription/index.js');
  }, 180_000);
  afterAll(() => t?.stop());

  describe('FeatureGuard (US-0.7 AC4)', () => {
    const probe = (feature: string) => {
      class Probe {
        @sub.RequiresFeature(feature)
        m() {}
      }
      return Probe;
    };
    // Gọi guard như Nest làm: ctx.tenantId do MembershipGuard gán từ vai trò của user.
    const gate = async (
      who: Who,
      tenantId: string | null = who.tenantId,
      feature = 'compliance.form02',
    ): Promise<unknown> => {
      const Probe = probe(feature);
      const guard = t.app.get(sub.FeatureGuard, { strict: false });
      return guard
        .canActivate({
          getHandler: () => Probe.prototype.m,
          getClass: () => Probe,
          switchToHttp: () => ({
            getRequest: () => ({
              ctx: {
                requestId: 'r',
                userId: who.userId,
                sessionId: null,
                tenantId,
              },
            }),
          }),
        } as never)
        .catch((e: unknown) => e);
    };

    it('Free → 402 FEATURE_REQUIRES_PRO kèm feature; Pro → cho qua; tenant khác không thấy Pro của tenant này', async () => {
      const [free, pro] = [await mk('free'), await mk('pro')];
      expect(await gate(pro)).toBe(true);
      expect(await gate(free)).toMatchObject({
        code: 'FEATURE_REQUIRES_PRO',
        details: { feature: 'compliance.form02' },
      });
    });

    it('Pro hết hạn: về cờ Free ngay, không đợi job; dùng thử đang chạy thì mở', async () => {
      const w = await mk('pro');
      await q(
        `update subscriptions set current_period_end = now() - interval '1 minute' where tenant_id = $1`,
        [w.tenantId],
      );
      expect(await gate(w)).toMatchObject({ code: 'FEATURE_REQUIRES_PRO' });
      await q(
        `update subscriptions set status = 'trialing', current_period_end = now() + interval '3 days' where tenant_id = $1`,
        [w.tenantId],
      );
      expect(await gate(w)).toBe(true);
    });

    it('tenant_feature_overrides thắng cờ gói: bật cho Free, tắt cho Pro', async () => {
      const [free, pro] = [await mk('free'), await mk('pro')];
      await q(
        `insert into tenant_feature_overrides (tenant_id, feature_key, enabled) values ($1, 'compliance.form02', true), ($2, 'compliance.form02', false)`,
        [free.tenantId, pro.tenantId],
      );
      expect(await gate(free)).toBe(true);
      expect(await gate(pro)).toMatchObject({ code: 'FEATURE_REQUIRES_PRO' });
    });

    it('khóa lạ (không có dòng cờ) → coi là tắt; thiếu tenant → FORBIDDEN', async () => {
      const pro = await mk('pro');
      expect(await gate(pro, pro.tenantId, 'khong.ton.tai')).toMatchObject({
        code: 'FEATURE_REQUIRES_PRO',
      });
      expect(await gate(pro, null)).toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});
