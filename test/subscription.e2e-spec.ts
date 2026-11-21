import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

const SECRET = 'bi-mat-webhook-revenuecat-test';
const PRODUCT = 'teachhub_pro_yearly';
const DAY = 86_400_000;

// S7 subscription: plan-usage, dùng thử, đơn chuyển khoản, webhook RevenueCat (US-0.7, US-0.8).
describe('subscription: gói Free/Pro', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    who: { token: string } | null,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    key: string | null = method === 'POST' ? randomUUID() : null,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        ...(who ? { authorization: `Bearer ${who.token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });
  const mk = async (plan: 'free' | 'pro' = 'free'): Promise<Who> => {
    const s = await seedTenant(t.worker, plan);
    return { ...s, token: await t.tokenFor(s.userId) };
  };
  const usage = async (who: Who) =>
    (await call(who, 'GET', '/plan-usage')).json();
  const classBody = (name: string) => ({
    name,
    subject: 'Toán',
    grade: 9,
    mode: 'online',
    startDate: '2027-01-10',
  });
  const mkClass = (who: Who, name = 'Lớp') =>
    call(who, 'POST', '/classes', classBody(name));
  const mkStudent = (who: Who, fullName = 'Lê Gia Bảo') =>
    call(who, 'POST', '/students', { fullName, confirmNew: true });
  const sub = async (who: Who) =>
    (
      await q(`select * from subscriptions where tenant_id = $1`, [
        who.tenantId,
      ])
    )[0];

  let evSeq = 0;
  const hook = (
    who: { tenantId: string },
    over: Record<string, unknown> = {},
    auth: string | null = SECRET,
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/webhooks/revenuecat',
      headers: auth === null ? {} : { authorization: auth },
      payload: {
        api_version: '1.0',
        event: {
          id: `evt-${++evSeq}-${randomUUID()}`,
          type: 'INITIAL_PURCHASE',
          app_user_id: who.tenantId,
          product_id: PRODUCT,
          store: 'APP_STORE',
          environment: 'PRODUCTION',
          expiration_at_ms: Date.now() + 365 * DAY,
          event_timestamp_ms: Date.now(),
          ...over,
        },
      },
    });

  beforeAll(async () => {
    Object.assign(process.env, {
      REVENUECAT_WEBHOOK_SECRET: SECRET,
      REVENUECAT_PRO_PRODUCT_IDS: `${PRODUCT},teachhub_pro_once`,
      REVENUECAT_NON_RENEWING_DAYS: 'teachhub_pro_once:30',
      PRO_PRICE_VND: '250000',
      PAYEE_BANK_BIN: '970436',
      PAYEE_BANK_NAME: 'Vietcombank',
      PAYEE_ACCOUNT_NO: '0011004123456',
      PAYEE_ACCOUNT_NAME: 'CONG TY TEACHHUB',
    });
    t = await startTestApp();
    [A, B] = [await mk(), await mk()];
  }, 180_000);
  afterAll(() => t?.stop());

  describe('GET /plan-usage', () => {
    it('tenant mới: gói Free, giới hạn 3 lớp/20 học sinh, feature Pro tắt, được dùng thử; không token → 401', async () => {
      const r = await call(A, 'GET', '/plan-usage');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        plan: {
          code: 'free',
          status: 'free',
          source: null,
          currentPeriodEnd: null,
          daysLeft: null,
          trialUsedAt: null,
          trialAvailable: true,
        },
        limits: { maxActiveClasses: 3, maxActiveStudents: 20 },
        usage: { activeClasses: 0, activeStudents: 0 },
        readOnly: { classCount: 0, studentCount: 0 },
        proPriceVnd: 250000,
        pendingBankTransferOrder: null,
      });
      expect(r.json().features).toEqual([
        { key: 'compliance.form02', enabled: false },
        { key: 'compliance.form03', enabled: false },
        { key: 'reports.export', enabled: false },
        { key: 'revenue.export', enabled: false },
      ]);
      expect((await call(null, 'GET', '/plan-usage')).statusCode).toBe(401);
    });

    it('chỉ chủ tenant: nhân sự khác → 403', async () => {
      const u = await seedMember(t.worker, A.tenantId, 'teacher');
      const r = await call(
        { token: await t.tokenFor(u) },
        'GET',
        '/plan-usage',
      );
      expect(r.statusCode).toBe(403);
    });

    it('plan-usage: tenant khác không thấy gói, mức dùng và đơn của tenant này', async () => {
      const X = await mk();
      const Y = await mk();
      await mkClass(X);
      await mkStudent(X);
      await call(X, 'POST', '/subscription/trial');
      await call(X, 'POST', '/subscription/bank-transfer-orders', {
        planCode: 'pro',
      });
      const y = await usage(Y);
      expect(y.plan.status).toBe('free');
      expect(y.usage).toEqual({ activeClasses: 0, activeStudents: 0 });
      expect(y.pendingBankTransferOrder).toBeNull();
      const x = await usage(X);
      expect(x.usage).toEqual({ activeClasses: 1, activeStudents: 1 });
      expect(x.pendingBankTransferOrder).not.toBeNull();
    });
  });

  describe('giới hạn Free (US-0.7)', () => {
    it('lớp thứ 4 → 402 PLAN_LIMIT_EXCEEDED kèm chi tiết; lớp đã lưu trữ không tính', async () => {
      const X = await mk();
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const r = await mkClass(X, `Lớp ${i}`);
        expect(r.statusCode, r.body).toBe(201);
        ids.push(r.json().id);
      }
      const over = await mkClass(X, 'Lớp 4');
      expect(over.statusCode).toBe(402);
      expect(over.json()).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: {
          limit: 3,
          current: 3,
          attempted: 1,
          feature: 'max_active_classes',
        },
      });
      expect(
        (await call(X, 'POST', `/classes/${ids[0]}/archive`)).statusCode,
      ).toBe(200);
      expect((await mkClass(X, 'Lớp 4')).statusCode).toBe(201);
    });

    it('học sinh thứ 21 → 402; tenant khác vẫn thêm được', async () => {
      const X = await mk();
      const Y = await mk();
      await q(
        `insert into students (id, tenant_id, full_name)
         select gen_random_uuid(), $1, 'HS ' || g from generate_series(1, 20) g`,
        [X.tenantId],
      );
      const over = await mkStudent(X);
      expect(over.statusCode).toBe(402);
      expect(over.json()).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { limit: 20, current: 20, feature: 'max_active_students' },
      });
      expect((await mkStudent(Y)).statusCode).toBe(201);
    });

    it('hai request tạo lớp song song ở mức 2/3: chỉ một thành công', async () => {
      const X = await mk();
      await mkClass(X, 'a');
      await mkClass(X, 'b');
      const rs = await Promise.all([mkClass(X, 'c'), mkClass(X, 'd')]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 402]);
    });
  });

  describe('POST /subscription/trial (US-0.8 AC1)', () => {
    it('bắt đầu: Pro trialing 14 ngày, mở giới hạn và feature; lần 2 khi đang dùng thử → 409; Idempotency-Key bắt buộc', async () => {
      const X = await mk();
      expect(
        (await call(X, 'POST', '/subscription/trial', undefined, null))
          .statusCode,
      ).toBe(422);
      const key = randomUUID();
      const r = await call(X, 'POST', '/subscription/trial', undefined, key);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().plan).toMatchObject({
        code: 'pro',
        status: 'trialing',
        source: null,
        daysLeft: 14,
        trialAvailable: false,
      });
      expect(r.json().plan.trialUsedAt).not.toBeNull();
      expect(r.json().limits).toEqual({
        maxActiveClasses: null,
        maxActiveStudents: null,
      });
      expect(
        r.json().features.every((f: { enabled: boolean }) => f.enabled),
      ).toBe(true);
      // gửi lại cùng khóa: phát lại kết quả, không lỗi
      expect(
        (await call(X, 'POST', '/subscription/trial', undefined, key))
          .statusCode,
      ).toBe(200);
      expect((await call(X, 'POST', '/subscription/trial')).statusCode).toBe(
        409,
      );
      for (let i = 0; i < 4; i++)
        expect((await mkClass(X, `L${i}`)).statusCode).toBe(201);
    });

    it('dùng thử dùng rồi, hết hạn → 422 TRIAL_ALREADY_USED, về Free, 402 hoạt động lại, dữ liệu còn nguyên', async () => {
      const X = await mk();
      await call(X, 'POST', '/subscription/trial');
      for (let i = 0; i < 4; i++) await mkClass(X, `L${i}`);
      await q(
        `update subscriptions set current_period_end = now() - interval '1 minute' where tenant_id = $1`,
        [X.tenantId],
      );
      const u = await usage(X);
      expect(u.plan).toMatchObject({
        code: 'free',
        status: 'expired',
        daysLeft: 0,
        trialAvailable: false,
      });
      expect(u.limits.maxActiveClasses).toBe(3);
      expect(u.usage.activeClasses).toBe(4);
      expect(u.readOnly.classCount).toBe(1);
      const again = await call(X, 'POST', '/subscription/trial');
      expect(again.statusCode).toBe(422);
      expect(again.json().code).toBe('TRIAL_ALREADY_USED');
      expect((await mkClass(X, 'Lớp 5')).statusCode).toBe(402);
    });

    it('dùng thử của tenant A không đổi gói của tenant B', async () => {
      const X = await mk();
      const Y = await mk();
      await call(X, 'POST', '/subscription/trial');
      expect((await sub(Y)).status).toBe('free');
      expect((await usage(Y)).plan.trialAvailable).toBe(true);
    });

    it('hai request song song (khóa khác nhau): chỉ một thắng', async () => {
      const X = await mk();
      const rs = await Promise.all([
        call(X, 'POST', '/subscription/trial'),
        call(X, 'POST', '/subscription/trial'),
      ]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    });

    it('không phải chủ tenant → 403', async () => {
      const u = await seedMember(t.worker, A.tenantId, 'teacher');
      const r = await call(
        { token: await t.tokenFor(u) },
        'POST',
        '/subscription/trial',
      );
      expect(r.statusCode).toBe(403);
    });
  });

  describe('POST /subscription/bank-transfer-orders (US-0.8 AC3)', () => {
    it('đơn chuyển khoản của A không lộ sang B; mỗi tenant có đơn pending riêng', async () => {
      const X = await mk();
      const Y = await mk();
      const r1 = await call(X, 'POST', '/subscription/bank-transfer-orders', {
        planCode: 'pro',
      });
      expect(r1.statusCode, r1.body).toBe(201);
      const o = r1.json();
      expect(o).toMatchObject({
        planCode: 'pro',
        amount: 250000,
        status: 'pending',
        payee: {
          bankBin: '970436',
          bankName: 'Vietcombank',
          accountNo: '0011004123456',
          accountName: 'CONG TY TEACHHUB',
        },
      });
      expect(o.transferNote).toMatch(/^[A-Z0-9 ]{1,25}$/);
      expect(o.qrPayload).toMatch(/^000201/);
      // đơn pending sẵn có → trả lại đúng đơn đó (khóa khác), không tạo trùng
      const r2 = await call(X, 'POST', '/subscription/bank-transfer-orders', {
        planCode: 'pro',
      });
      expect(r2.statusCode).toBe(201);
      expect(r2.json().id).toBe(o.id);
      expect(
        await q(`select 1 from bank_transfer_orders where tenant_id = $1`, [
          X.tenantId,
        ]),
      ).toHaveLength(1);
      expect((await usage(X)).pendingBankTransferOrder.id).toBe(o.id);
      expect((await usage(Y)).pendingBankTransferOrder).toBeNull();
      const ry = await call(Y, 'POST', '/subscription/bank-transfer-orders', {
        planCode: 'pro',
      });
      expect(ry.json().id).not.toBe(o.id);
      expect(ry.json().transferNote).not.toBe(o.transferNote);
    });

    it('thân sai → 422; thiếu Idempotency-Key → 422; không phải chủ tenant → 403; không đổi gói', async () => {
      const X = await mk();
      expect(
        (
          await call(X, 'POST', '/subscription/bank-transfer-orders', {
            planCode: 'free',
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await call(
            X,
            'POST',
            '/subscription/bank-transfer-orders',
            { planCode: 'pro' },
            null,
          )
        ).statusCode,
      ).toBe(422);
      const u = await seedMember(t.worker, X.tenantId, 'accountant');
      expect(
        (
          await call(
            { token: await t.tokenFor(u) },
            'POST',
            '/subscription/bank-transfer-orders',
            { planCode: 'pro' },
          )
        ).statusCode,
      ).toBe(403);
      expect((await sub(X)).status).toBe('free');
    });

    it('RLS: app không tự đổi gói hay xác nhận đơn bằng quyền teachhub_app', async () => {
      const X = await mk();
      await call(X, 'POST', '/subscription/bank-transfer-orders', {
        planCode: 'pro',
      });
      const pg = (await import('pg')).default;
      const app = new pg.Client({ connectionString: t.db.url('teachhub_app') });
      await app.connect();
      try {
        await app.query('begin');
        await app.query(`select set_config('app.user_id', $1, true)`, [
          X.userId,
        ]);
        const upd = await app.query(
          `update subscriptions set plan_code = 'pro', status = 'active' where tenant_id = $1`,
          [X.tenantId],
        );
        const ord = await app.query(
          `update bank_transfer_orders set status = 'confirmed' where tenant_id = $1`,
          [X.tenantId],
        );
        expect([upd.rowCount, ord.rowCount]).toEqual([0, 0]);
        await app.query('rollback');
      } finally {
        await app.end();
      }
      expect((await sub(X)).status).toBe('free');
    });
  });

  describe('POST /webhooks/revenuecat (US-0.8 AC2)', () => {
    it('thiếu hoặc sai bí mật → 401, không đổi gói, không ghi sự kiện', async () => {
      const X = await mk();
      for (const auth of [null, 'sai', `${SECRET}x`, `Bearer ${SECRET}`]) {
        expect((await hook(X, {}, auth)).statusCode).toBe(401);
      }
      expect((await sub(X)).status).toBe('free');
      expect(
        await q(`select 1 from subscription_events where tenant_id = $1`, [
          X.tenantId,
        ]),
      ).toHaveLength(0);
    });

    it('thân sai định dạng → 422', async () => {
      const r = await t.app.inject({
        method: 'POST',
        url: '/v1/webhooks/revenuecat',
        headers: { authorization: SECRET },
        payload: { event: { type: 'X' } },
      });
      expect(r.statusCode).toBe(422);
    });

    it('INITIAL_PURCHASE → Pro active theo kho; lặp event.id → duplicate, chỉ một sự kiện, một lần áp dụng', async () => {
      const X = await mk();
      const exp = Date.now() + 365 * DAY;
      const r = await hook(X, { id: 'dup-1', expiration_at_ms: exp });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: 'processed' });
      const s = await sub(X);
      expect(s).toMatchObject({
        plan_code: 'pro',
        status: 'active',
        source: 'app_store',
        external_ref: PRODUCT,
      });
      expect(s.current_period_end.getTime()).toBe(exp);
      const auditBefore = await q(
        `select 1 from audit_logs where entity = 'subscriptions' and tenant_id = $1`,
        [X.tenantId],
      );
      const again = await hook(X, {
        id: 'dup-1',
        expiration_at_ms: exp + 400 * DAY,
      });
      expect(again.json()).toEqual({ status: 'duplicate' });
      expect((await sub(X)).current_period_end.getTime()).toBe(exp);
      expect(
        await q(`select 1 from subscription_events where event_id = 'dup-1'`),
      ).toHaveLength(1);
      expect(
        await q(
          `select 1 from audit_logs where entity = 'subscriptions' and tenant_id = $1`,
          [X.tenantId],
        ),
      ).toHaveLength(auditBefore.length);
      const u = await usage(X);
      expect(u.plan).toMatchObject({
        code: 'pro',
        status: 'active',
        source: 'app_store',
      });
      expect(u.limits.maxActiveClasses).toBeNull();
    });

    it('webhook: sự kiện của tenant A không đổi gói của tenant B', async () => {
      const X = await mk();
      const Y = await mk();
      await hook(X, { store: 'PLAY_STORE' });
      expect((await sub(X)).source).toBe('play_store');
      expect((await sub(Y)).status).toBe('free');
      expect(
        await q(`select 1 from subscription_events where tenant_id = $1`, [
          Y.tenantId,
        ]),
      ).toHaveLength(0);
    });

    it('hai lần giao đồng thời cùng event.id: chỉ một lần áp dụng', async () => {
      const X = await mk();
      const rs = await Promise.all([
        hook(X, { id: 'race-1' }),
        hook(X, { id: 'race-1' }),
      ]);
      expect(rs.map((r) => r.json().status).sort()).toEqual([
        'duplicate',
        'processed',
      ]);
    });

    it('product_id thiếu hoặc lạ → 200 ignored, không đổi entitlement', async () => {
      const X = await mk();
      for (const product_id of ['san_pham_la', undefined]) {
        const r = await hook(X, { product_id });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual({ status: 'ignored' });
      }
      expect((await sub(X)).status).toBe('free');
    });

    it('chỉ active khi hạn ở tương lai: hạn quá khứ hoặc thiếu hạn → ignored; mua một lần không hạn lấy thời lượng cấu hình', async () => {
      const X = await mk();
      expect(
        (await hook(X, { expiration_at_ms: Date.now() - 1000 })).json().status,
      ).toBe('ignored');
      expect((await hook(X, { expiration_at_ms: null })).json().status).toBe(
        'ignored',
      );
      // sản phẩm một lần không có cấu hình thời lượng (nằm trong allowlist nhưng không có hạn) → ignored
      expect(
        (
          await hook(X, {
            type: 'NON_RENEWING_PURCHASE',
            product_id: PRODUCT,
            expiration_at_ms: null,
          })
        ).json().status,
      ).toBe('ignored');
      expect((await sub(X)).status).toBe('free');
      const ts = Date.now();
      const r = await hook(X, {
        type: 'NON_RENEWING_PURCHASE',
        product_id: 'teachhub_pro_once',
        expiration_at_ms: null,
        event_timestamp_ms: ts,
      });
      expect(r.json().status).toBe('processed');
      expect((await sub(X)).current_period_end.getTime()).toBe(ts + 30 * DAY);
    });

    it('sự kiện cũ đến muộn không ghi đè trạng thái mới hơn', async () => {
      const X = await mk();
      const t0 = Date.now();
      const newer = t0 - 1000;
      expect(
        (
          await hook(X, {
            type: 'RENEWAL',
            event_timestamp_ms: newer,
            expiration_at_ms: t0 + 390 * DAY,
          })
        ).json().status,
      ).toBe('processed');
      const stale = await hook(X, {
        type: 'RENEWAL',
        event_timestamp_ms: t0 - 5000,
        expiration_at_ms: t0 + 100 * DAY,
      });
      expect(stale.json()).toEqual({ status: 'ignored' });
      expect((await sub(X)).current_period_end.getTime()).toBe(t0 + 390 * DAY);
      // EXPIRATION cũ cũng không hạ gói mới
      const oldExp = await hook(X, {
        type: 'EXPIRATION',
        event_timestamp_ms: t0 - 3000,
        expiration_at_ms: t0,
      });
      expect(oldExp.json().status).toBe('ignored');
      expect((await sub(X)).status).toBe('active');
    });

    it('CANCELLATION/BILLING_ISSUE giữ Pro tới hết kỳ; EXPIRATION → expired, giới hạn 402 hoạt động lại', async () => {
      const X = await mk();
      await hook(X, { event_timestamp_ms: Date.now() - 5000 });
      for (let i = 0; i < 4; i++)
        expect((await mkClass(X, `L${i}`)).statusCode).toBe(201);
      for (const type of ['CANCELLATION', 'BILLING_ISSUE']) {
        const r = await hook(X, {
          type,
          event_timestamp_ms: Date.now() - 4000,
        });
        expect(r.statusCode).toBe(200);
      }
      expect((await sub(X)).status).toBe('active');
      const r = await hook(X, {
        type: 'EXPIRATION',
        event_timestamp_ms: Date.now(),
        expiration_at_ms: Date.now(),
      });
      expect(r.json()).toEqual({ status: 'processed' });
      expect(await sub(X)).toMatchObject({
        plan_code: 'free',
        status: 'expired',
      });
      const u = await usage(X);
      expect(u.plan).toMatchObject({ code: 'free', status: 'expired' });
      expect(u.limits.maxActiveClasses).toBe(3);
      expect(u.usage.activeClasses).toBe(4);
      expect((await mkClass(X, 'L5')).statusCode).toBe(402);
      // gia hạn lại → mở lại ngay
      await hook(X, { type: 'RENEWAL', event_timestamp_ms: Date.now() + 1000 });
      expect((await mkClass(X, 'L5')).statusCode).toBe(201);
    });

    it('EXPIRATION của kho khác với nguồn thu hiện tại không hạ gói chuyển khoản', async () => {
      const X = await mk();
      await q(
        `update subscriptions set plan_code='pro', status='active', source='bank_transfer', current_period_end = now() + interval '200 days' where tenant_id = $1`,
        [X.tenantId],
      );
      expect((await hook(X, { type: 'EXPIRATION' })).json().status).toBe(
        'ignored',
      );
      expect((await sub(X)).status).toBe('active');
    });

    it('app_user_id không phải tenant có thật → 200 ignored; SANDBOX ở production bị bỏ qua, ở môi trường khác áp dụng', async () => {
      expect((await hook({ tenantId: 'khong-phai-uuid' })).json()).toEqual({
        status: 'ignored',
      });
      expect((await hook({ tenantId: randomUUID() })).json()).toEqual({
        status: 'ignored',
      });
      const X = await mk();
      expect((await hook(X, { environment: 'SANDBOX' })).json().status).toBe(
        'processed',
      );
    });

    it('TEST và loại lạ → ignored; sự kiện lưu không chứa PII ngoài trường kỹ thuật', async () => {
      const X = await mk();
      expect((await hook(X, { type: 'TEST' })).json().status).toBe('ignored');
      expect((await hook(X, { type: 'TRANSFER' })).json().status).toBe(
        'ignored',
      );
      await hook(X, {
        id: 'pii-1',
        email: 'a@b.c',
        subscriber_attributes: { $email: { value: 'a@b.c' } },
      });
      const [ev] = await q(
        `select payload from subscription_events where event_id = 'pii-1'`,
      );
      expect(Object.keys(ev.payload).sort()).toEqual([
        'app_user_id',
        'environment',
        'event_timestamp_ms',
        'expiration_at_ms',
        'id',
        'product_id',
        'store',
        'type',
      ]);
    });
  });

  describe('gia cố webhook (review bảo mật)', () => {
    it('hàm rc_begin_event/rc_apply_event gọi từ role app không có cờ webhook → lỗi 42501, không đổi gì', async () => {
      const X = await mk();
      const pg = (await import('pg')).default;
      const app = new pg.Client({ connectionString: t.db.url('teachhub_app') });
      await app.connect();
      try {
        await expect(
          app.query(
            `select app_private.rc_begin_event('x1', $1::uuid, 'INITIAL_PURCHASE', now(), '{}'::jsonb)`,
            [X.tenantId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          app.query(
            `select app_private.rc_apply_event('x1', $1::uuid, 'pro', 'active', 'app_store', now() + interval '1 year', 'p')`,
            [X.tenantId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.end();
      }
      expect((await sub(X)).status).toBe('free');
      expect(
        await q(`select 1 from subscription_events where tenant_id = $1`, [
          X.tenantId,
        ]),
      ).toHaveLength(0);
    });

    it('đổi gói qua webhook ghi audit_logs; external_ref lưu sản phẩm kèm giao dịch gốc', async () => {
      const X = await mk();
      await hook(X, { original_transaction_id: 'tx-1' });
      expect((await sub(X)).external_ref).toBe(`${PRODUCT}#tx-1`);
      const audit = await q(
        `select action from audit_logs where entity = 'subscriptions' and tenant_id = $1`,
        [X.tenantId],
      );
      expect(audit.length).toBeGreaterThan(0);
    });

    it('kỳ chuyển khoản đang còn dài không bị store rút ngắn; kỳ store dài hơn thì ghi đè', async () => {
      const X = await mk();
      const end = Date.now() + 300 * DAY;
      await q(
        `update subscriptions set plan_code='pro', status='active', source='bank_transfer', current_period_end = $2 where tenant_id = $1`,
        [X.tenantId, new Date(end)],
      );
      const short = await hook(X, {
        store: 'PLAY_STORE',
        expiration_at_ms: Date.now() + 30 * DAY,
      });
      expect(short.json()).toEqual({ status: 'ignored' });
      expect(await sub(X)).toMatchObject({ source: 'bank_transfer' });
      expect((await sub(X)).current_period_end.getTime()).toBe(end);
      const longer = await hook(X, {
        store: 'PLAY_STORE',
        expiration_at_ms: end + 60 * DAY,
      });
      expect(longer.json()).toEqual({ status: 'processed' });
      expect((await sub(X)).source).toBe('play_store');
    });

    it('EXPIRATION chỉ hạ khi product_id và original_transaction_id khớp kỳ đang lưu', async () => {
      const X = await mk();
      await hook(X, {
        original_transaction_id: 'tx-1',
        event_timestamp_ms: Date.now() - 10_000,
      });
      const exp = (o: Record<string, unknown>) =>
        hook(X, {
          type: 'EXPIRATION',
          expiration_at_ms: Date.now(),
          event_timestamp_ms: Date.now() - 5000,
          ...o,
        });
      expect(
        (await exp({ product_id: 'teachhub_pro_once' })).json().status,
      ).toBe('ignored');
      expect(
        (await exp({ original_transaction_id: 'tx-khac' })).json().status,
      ).toBe('ignored');
      expect((await sub(X)).status).toBe('active');
      expect(
        (await exp({ original_transaction_id: 'tx-1' })).json().status,
      ).toBe('processed');
      expect((await sub(X)).status).toBe('expired');
    });

    it('sự kiện đã ignored được xử lý lại khi gửi lại; chỉ processed mới là duplicate', async () => {
      const X = await mk();
      const t0 = Date.now();
      const expiration = {
        id: 'redeliver-1',
        type: 'EXPIRATION',
        expiration_at_ms: t0,
        event_timestamp_ms: t0,
      };
      // Chưa có kỳ Pro nào: bị bỏ qua (not_current_source)
      expect((await hook(X, expiration)).json().status).toBe('ignored');
      expect(
        (
          await q(
            `select outcome from subscription_events where event_id = 'redeliver-1'`,
          )
        )[0].outcome,
      ).toBe('ignored');
      await hook(X, { event_timestamp_ms: t0 - 1000 });
      // RevenueCat gửi lại cùng event.id: giờ áp dụng được
      expect((await hook(X, expiration)).json().status).toBe('processed');
      expect((await sub(X)).status).toBe('expired');
      expect((await hook(X, expiration)).json().status).toBe('duplicate');
      expect(
        await q(
          `select 1 from subscription_events where event_id = 'redeliver-1'`,
        ),
      ).toHaveLength(1);
    });

    it('chặn thời gian: giá trị vượt trần → 422; hạn > 400 ngày, thiếu event_timestamp_ms, mốc tương lai xa → ignored', async () => {
      const X = await mk();
      expect(
        (await hook(X, { expiration_at_ms: 4_102_444_800_001 })).statusCode,
      ).toBe(422);
      expect(
        (await hook(X, { event_timestamp_ms: 4_102_444_800_001 })).statusCode,
      ).toBe(422);
      expect((await hook(X, { event_timestamp_ms: -1 })).statusCode).toBe(422);
      expect(
        (await hook(X, { expiration_at_ms: Date.now() + 401 * DAY })).json()
          .status,
      ).toBe('ignored');
      expect(
        (await hook(X, { event_timestamp_ms: undefined })).json().status,
      ).toBe('ignored');
      expect(
        (await hook(X, { event_timestamp_ms: Date.now() + 30 * DAY })).json()
          .status,
      ).toBe('ignored');
      expect((await sub(X)).status).toBe('free');
      await hook(X, { event_timestamp_ms: Date.now() - 1000 });
      expect(
        (
          await hook(X, { type: 'EXPIRATION', event_timestamp_ms: undefined })
        ).json().status,
      ).toBe('ignored');
      expect((await sub(X)).status).toBe('active');
    });

    it('log cảnh báo không PII khi tenant lạ', async () => {
      const { Logger } = await import('@nestjs/common');
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const ghost = randomUUID();
        expect((await hook({ tenantId: ghost })).json()).toEqual({
          status: 'ignored',
        });
        const msgs = warn.mock.calls.map((c) => String(c[0]));
        expect(msgs.some((m) => m.includes('reason=unknown_tenant'))).toBe(
          true,
        );
        expect(
          msgs.every((m) => !m.includes(ghost) && !m.includes(PRODUCT)),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
