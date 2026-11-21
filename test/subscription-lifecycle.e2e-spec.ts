import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S7 subscription (phần còn lại sau #194): FeatureGuard, job subscription.lifecycle, admin xác nhận chuyển khoản
// (US-0.7 AC4, US-0.8 AC3, AC4, AC5).
describe('subscription: vòng đời gói', () => {
  let t: TestApp;
  // Nạp sau khi đặt env (module `core` đọc env lúc nạp).
  let jobPool: pg.Pool;
  let lifecycle: import('../libs/modules/subscription/application/lifecycle.job.js').SubscriptionLifecycleJob;
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
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    jobPool = new pg.Pool({ connectionString: t.db.url('teachhub_worker') });
    const tx = new TxService(
      drizzle(jobPool, { schema, casing: 'snake_case' }),
    );
    lifecycle = new sub.SubscriptionLifecycleJob(tx, new JobRuns(tx));
  }, 180_000);
  afterAll(async () => {
    await jobPool?.end();
    await t?.stop();
  });

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

  describe('job subscription.lifecycle (US-0.8 AC4, AC5)', () => {
    const DAY = 86_400_000;
    const setEnd = (who: Who, end: Date, status = 'active') =>
      q(
        `update subscriptions set status = $2, plan_code = 'pro', current_period_end = $3 where tenant_id = $1`,
        [who.tenantId, status, end],
      );
    const events = (who: Who) =>
      q(
        `select payload from outbox_events where tenant_id = $1 and type = 'subscription_expiring' order by created_at`,
        [who.tenantId],
      );
    const post = (who: Who, url: string, payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/v1${url}`,
        payload,
        headers: {
          authorization: `Bearer ${who.token}`,
          'idempotency-key': randomUUID(),
        },
      });

    it('hết hạn: chốt expired/free bền vững, 402 giới hạn Free quay lại, dữ liệu còn nguyên; chạy lại không đổi gì', async () => {
      const w = await mk('pro');
      for (let i = 0; i < 4; i++)
        expect(
          (
            await post(w, '/classes', {
              name: `Lớp ${i}`,
              subject: 'Toán',
              grade: 9,
              mode: 'online',
              startDate: '2027-01-10',
            })
          ).statusCode,
        ).toBe(201);
      await setEnd(w, new Date(Date.now() - 1000), 'trialing');
      await lifecycle.run();
      const [row] = await q(
        `select status, plan_code, source from subscriptions where tenant_id = $1`,
        [w.tenantId],
      );
      expect(row).toMatchObject({ status: 'expired', plan_code: 'free' });
      const r = await post(w, '/classes', {
        name: 'Lớp 5',
        subject: 'Toán',
        grade: 9,
        mode: 'online',
        startDate: '2027-01-10',
      });
      expect(r.statusCode).toBe(402);
      expect(r.json().code).toBe('PLAN_LIMIT_EXCEEDED');
      const [{ n }] = await q(
        `select count(*)::int as n from classes where tenant_id = $1`,
        [w.tenantId],
      );
      expect(n).toBe(4);
      expect(await events(w)).toHaveLength(0);
      const [run] = await q(
        `select status from job_runs where job = 'subscription.lifecycle' order by started_at desc limit 1`,
      );
      expect(run.status).toBe('succeeded');
    });

    it('nhắc 7 ngày rồi 1 ngày, chạy lại không nhắc trùng; gói còn xa hoặc tenant khác không bị nhắc', async () => {
      const [a, far, free] = [await mk('pro'), await mk('pro'), await mk()];
      const end = new Date(Date.now() + 6 * DAY);
      await setEnd(a, end);
      await setEnd(far, new Date(Date.now() + 30 * DAY));
      await lifecycle.run();
      await lifecycle.run();
      expect(await events(a)).toEqual([
        { payload: { offsetDays: 7, currentPeriodEnd: end.toISOString() } },
      ]);
      const lastDay = new Date(end.getTime() - 12 * 3600_000);
      await lifecycle.run(lastDay);
      await lifecycle.run(lastDay);
      expect((await events(a)).map((e) => e.payload.offsetDays)).toEqual([
        7, 1,
      ]);
      expect(await events(far)).toHaveLength(0);
      expect(await events(free)).toHaveLength(0);
    });

    it('gia hạn đổi hạn thì kỳ mới được nhắc lại; outbox không chứa PII', async () => {
      const w = await mk('pro');
      await setEnd(w, new Date(Date.now() + 5 * DAY));
      await lifecycle.run();
      const next = new Date(Date.now() + 6 * DAY);
      await setEnd(w, next);
      await lifecycle.run();
      const ev = await events(w);
      expect(ev).toHaveLength(2);
      expect(Object.keys(ev[1].payload).sort()).toEqual([
        'currentPeriodEnd',
        'offsetDays',
      ]);
    });

    it('SubscriptionNotifier: một thông báo cho chủ tenant dù xử lý lại; kỳ đã gia hạn thì bỏ; chéo tenant không nhận', async () => {
      const { SubscriptionNotifier } =
        await import('../libs/modules/notifications/application/subscription-notifier.service.js');
      const schema = await import('../libs/db/src/schema/index.js');
      const { TxService } = await import('../libs/db/src/tx.service.js');
      const deliver = vi.fn().mockResolvedValue(true);
      const notifier = new SubscriptionNotifier(
        new TxService(drizzle(jobPool, { schema, casing: 'snake_case' })),
        { deliver } as never,
      );
      const [w, other] = [await mk('pro'), await mk('pro')];
      const end = new Date(Date.now() + 5 * DAY);
      await setEnd(w, end);
      const job = {
        eventId: randomUUID(),
        tenantId: w.tenantId,
        payload: { offsetDays: 7, currentPeriodEnd: end.toISOString() },
      };
      await notifier.handleExpiring(job);
      await notifier.handleExpiring(job);
      const rows = await q(
        `select recipient_user_id, type from notifications where type = 'subscription_expiring' and tenant_id in ($1, $2)`,
        [w.tenantId, other.tenantId],
      );
      expect(rows).toEqual([
        { recipient_user_id: w.userId, type: 'subscription_expiring' },
      ]);
      // Gia hạn sau khi sự kiện được chốt: hạn khác → không thông báo.
      await setEnd(w, new Date(end.getTime() + 365 * DAY));
      await notifier.handleExpiring({ ...job, eventId: randomUUID() });
      expect(
        (
          await q(
            `select 1 from notifications where tenant_id = $1 and type = 'subscription_expiring'`,
            [w.tenantId],
          )
        ).length,
      ).toBe(1);
    });
  });
});
