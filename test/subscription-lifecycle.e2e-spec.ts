import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

const ADMIN_SECRET = 'bi-mat-bff-admin-test-0123';
const PERM = '/teachhub/admin/bank-transfer';
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
      ADMIN_API_SECRET: ADMIN_SECRET,
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

  describe('admin xác nhận chuyển khoản (US-0.8 AC3)', () => {
    const adminHeaders = (
      over: Record<string, string | undefined> = {},
    ): Record<string, string> =>
      Object.fromEntries(
        Object.entries({
          'x-admin-secret': ADMIN_SECRET,
          'x-admin-user-id': 'iam-user-0042',
          'x-admin-permissions': PERM,
          ...over,
        }).filter(([, v]) => v !== undefined),
      ) as Record<string, string>;
    const list = (
      over: Record<string, string | undefined> = {},
      status = 'pending',
    ) =>
      t.app.inject({
        method: 'GET',
        url: `/v1/admin/bank-transfer-orders?status=${status}&pageSize=100`,
        headers: adminHeaders(over),
      });
    const mkOrder = async (who: Who) => {
      const r = await t.app.inject({
        method: 'POST',
        url: '/v1/subscription/bank-transfer-orders',
        payload: { planCode: 'pro' },
        headers: {
          authorization: `Bearer ${who.token}`,
          'idempotency-key': randomUUID(),
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    const find = async (id: string, status = 'pending') =>
      (await list({}, status))
        .json()
        .items.find((o: { id: string }) => o.id === id);
    const confirm = (
      id: string,
      body: object,
      over: Record<string, string | undefined> = {},
    ) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/admin/bank-transfer-orders/${id}/confirm`,
        payload: body,
        headers: adminHeaders({ 'idempotency-key': randomUUID(), ...over }),
      });
    const body = (o: { amount: number; updatedAt: string }, ref = 'FT001') => ({
      amount: o.amount,
      bankTransactionRef: ref,
      expectedUpdatedAt: o.updatedAt,
    });
    const subOf = async (who: Who) =>
      (
        await q(`select * from subscriptions where tenant_id = $1`, [
          who.tenantId,
        ])
      )[0];
    const MONTH12 = (from: Date) => {
      const d = new Date(from);
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d.getTime();
    };

    it('không đủ ba header hoặc sai → 401; quyền khác route → 403; token người dùng không thay được admin', async () => {
      for (const over of [
        { 'x-admin-secret': undefined },
        { 'x-admin-secret': 'sai-bi-mat-sai-bi-mat' },
        { 'x-admin-user-id': undefined },
        { 'x-admin-user-id': '   ' },
      ])
        expect((await list(over)).statusCode, JSON.stringify(over)).toBe(401);
      for (const perm of [
        undefined,
        '/teachhub/admin/support',
        '/teachhub/admin/legal-articles',
      ])
        expect(
          (await list({ 'x-admin-permissions': perm })).statusCode,
          String(perm),
        ).toBe(403);
      const owner = await mk();
      const r = await t.app.inject({
        method: 'GET',
        url: '/v1/admin/bank-transfer-orders',
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(r.statusCode).toBe(401);
      // Route admin khác vẫn 501 sau khi qua guard, và 403 nếu sai quyền.
      const legal = (perm: string) =>
        t.app.inject({
          method: 'GET',
          url: '/v1/admin/legal-articles',
          headers: adminHeaders({ 'x-admin-permissions': perm }),
        });
      expect((await legal(PERM)).statusCode).toBe(403);
      expect((await legal('/teachhub/admin/legal-articles')).statusCode).toBe(
        501,
      );
    });

    it('xác nhận đơn pending: Pro active nguồn bank_transfer 12 tháng, đơn confirmed, push outbox, audit, plan-usage thấy Pro', async () => {
      const w = await mk();
      const id = await mkOrder(w);
      const o = await find(id);
      expect(o).toMatchObject({
        tenantId: w.tenantId,
        status: 'pending',
        amount: 250000,
      });
      const before = Date.now();
      const r = await confirm(id, body(o, 'FT-A1'));
      expect(r.statusCode, r.body).toBe(200);
      const res = r.json();
      expect(res.order).toMatchObject({
        status: 'confirmed',
        confirmedBy: 'iam-user-0042',
        bankTransactionRef: 'FT-A1',
      });
      expect(res.subscription).toMatchObject({
        planCode: 'pro',
        status: 'active',
      });
      expect(
        Math.abs(
          new Date(res.subscription.currentPeriodEnd).getTime() -
            MONTH12(new Date(before)),
        ),
      ).toBeLessThan(60_000);
      expect(await subOf(w)).toMatchObject({
        plan_code: 'pro',
        status: 'active',
        source: 'bank_transfer',
      });
      const ev = await q(
        `select payload from outbox_events where tenant_id = $1 and type = 'subscription_activated'`,
        [w.tenantId],
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].payload.source).toBe('bank_transfer');
      const audit = await q(
        `select entity, after_data from audit_logs where tenant_id = $1 and entity in ('bank_transfer_orders', 'subscriptions') order by created_at`,
        [w.tenantId],
      );
      expect(
        audit.some(
          (a) =>
            a.entity === 'bank_transfer_orders' &&
            a.after_data.confirmed_by === 'iam-user-0042',
        ),
      ).toBe(true);
      expect(
        audit.some(
          (a) =>
            a.entity === 'subscriptions' &&
            a.after_data.source === 'bank_transfer',
        ),
      ).toBe(true);
      const usage = await t.app.inject({
        method: 'GET',
        url: '/v1/plan-usage',
        headers: { authorization: `Bearer ${w.token}` },
      });
      expect(usage.json()).toMatchObject({
        plan: { code: 'pro', source: 'bank_transfer' },
        pendingBankTransferOrder: null,
      });
      expect((await find(id, 'confirmed')).status).toBe('confirmed');
      expect(await find(id)).toBeUndefined();
    });

    it('xác nhận hai lần: một kỳ, một push; gọi lại khác mã giao dịch hoặc dữ liệu cũ → 409', async () => {
      const w = await mk();
      const id = await mkOrder(w);
      const o = await find(id);
      const first = await confirm(id, body(o, 'FT-B1'));
      const end1 = (await subOf(w)).current_period_end;
      const again = await confirm(id, body(o, 'FT-B1'));
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().subscription).toEqual(first.json().subscription);
      expect((await subOf(w)).current_period_end).toEqual(end1);
      const other = await confirm(id, body(o, 'FT-KHAC'));
      expect(other.statusCode).toBe(409);
      expect(other.json().code).toBe('CONFLICT_STALE');
      expect(
        await q(
          `select 1 from outbox_events where tenant_id = $1 and type = 'subscription_activated'`,
          [w.tenantId],
        ),
      ).toHaveLength(1);
      // Admin khác xác nhận lại đơn đã xong cũng là 409, không cộng kỳ.
      const stranger = await confirm(id, body(o, 'FT-B1'), {
        'x-admin-user-id': 'iam-user-9999',
      });
      expect(stranger.statusCode).toBe(409);
      expect((await subOf(w)).current_period_end).toEqual(end1);
    });

    it('đang Pro còn hạn: cộng nối từ hạn hiện tại, không rút ngắn', async () => {
      const w = await mk('pro');
      const cur = new Date(Date.now() + 100 * 86_400_000);
      await q(
        `update subscriptions set current_period_end = $2 where tenant_id = $1`,
        [w.tenantId, cur],
      );
      const id = await mkOrder(w);
      const r = await confirm(id, body(await find(id), 'FT-C1'));
      expect(r.statusCode, r.body).toBe(200);
      expect(new Date(r.json().subscription.currentPeriodEnd).getTime()).toBe(
        MONTH12(cur),
      );
    });

    it('tenant hết hạn dùng thử tính từ bây giờ, không từ hạn cũ; đơn của tenant khác không đổi gói của tenant này', async () => {
      const [a, b] = [await mk(), await mk()];
      await q(
        `update subscriptions set status = 'expired', plan_code = 'free', current_period_end = now() - interval '30 days' where tenant_id = $1`,
        [a.tenantId],
      );
      const [ia] = [await mkOrder(a), await mkOrder(b)];
      const r = await confirm(ia, body(await find(ia), 'FT-D1'));
      expect(
        Math.abs(
          new Date(r.json().subscription.currentPeriodEnd).getTime() -
            MONTH12(new Date()),
        ),
      ).toBeLessThan(60_000);
      expect(await subOf(b)).toMatchObject({
        plan_code: 'free',
        status: 'free',
      });
      expect(
        await q(
          `select status from bank_transfer_orders where tenant_id = $1`,
          [b.tenantId],
        ),
      ).toEqual([{ status: 'pending' }]);
    });

    it('sai số tiền → 422 ở trường amount; expectedUpdatedAt lệch → 409; id lạ → 404; thiếu Idempotency-Key → 422; không đổi gói', async () => {
      const w = await mk();
      const id = await mkOrder(w);
      const o = await find(id);
      const bad = await confirm(id, { ...body(o), amount: o.amount - 1 });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().errors).toHaveProperty('amount');
      const stale = await confirm(id, {
        ...body(o),
        expectedUpdatedAt: '2020-01-01T00:00:00Z',
      });
      expect(stale.statusCode).toBe(409);
      expect((await confirm(randomUUID(), body(o))).statusCode).toBe(404);
      expect(
        (await confirm(id, body(o), { 'idempotency-key': undefined }))
          .statusCode,
      ).toBe(422);
      expect(await subOf(w)).toMatchObject({
        plan_code: 'free',
        status: 'free',
      });
      expect((await find(id)).status).toBe('pending');
    });

    it('role app gọi thẳng hàm admin khi không có cờ → 42501, không đổi gì', async () => {
      const w = await mk();
      const id = await mkOrder(w);
      const o = await find(id);
      const app = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
      try {
        await expect(
          app.query(
            `select app_private.admin_confirm_bank_transfer($1, $2, 'X', $3)`,
            [id, o.amount, o.updatedAt],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.end();
      }
      expect(await subOf(w)).toMatchObject({ status: 'free' });
    });
  });
});
