import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { startTestDb, type TestDb } from './containers.js';
import { onboardingJourney } from './support/onboarding-journey.js';

// S2-BE-10 / US-0.1, US-0.10, US-0.2: hành trình người dùng mới từ gửi OTP đến xong 5 bước onboarding.
// Bổ sung cho test/onboarding.e2e-spec.ts (đi thẳng qua SessionService); ở đây đi trọn đường đăng nhập thật.
// Mỗi lượt gửi OTP đi qua SMTP thật tới Mailpit; máy chạy container chậm (Colima) nên nới timeout mặc định 5 giây.
describe('Hành trình onboarding: OTP → chọn vai trò → 5 bước', { timeout: 30_000 }, () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let worker: pg.Pool;
  let app: NestFastifyApplication;
  let journey: ReturnType<typeof onboardingJourney>;

  beforeAll(async () => {
    [db, redis, mailpit] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
      new GenericContainer('axllent/mailpit:v1.33.1')
        .withExposedPorts(1025, 8025)
        .start(),
    ]);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url('teachhub_app'),
      REDIS_URL: redis.getConnectionUrl(),
      // 127.0.0.1: `localhost` có thể ra IPv6 mà cổng chỉ mở ở IPv4.
      SMTP_URL: `smtp://127.0.0.1:${mailpit.getMappedPort(1025)}`,
      // Kho S3 không dùng ở đây; client chỉ được dựng, không gọi.
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_BUCKET_PRIVATE: 'x',
    });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    journey = onboardingJourney(
      app,
      `http://127.0.0.1:${mailpit.getMappedPort(8025)}/api/v1`,
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await worker?.end();
    await Promise.all([db?.container.stop(), redis?.stop(), mailpit?.stop()]);
  });

  it('happy path: gửi OTP → đăng nhập (chưa vai trò) → chọn Giáo viên → 5 bước done → currentStep tiến dần rồi null', async () => {
    const email = `gv.${randomUUID().slice(0, 8)}@example.com`;
    expect((await journey.sendOtp(email)).statusCode).toBe(204);

    const code = await journey.lastCode(email);
    const login = await journey.login(email, code);
    expect(login.statusCode).toBe(200);
    const body = login.json() as {
      access_token: string;
      user: { email: string; permissions: string[] };
    };
    // US-0.1 AC1: email mới = đăng ký, chưa có vai trò.
    expect(body.user.email).toBe(email);
    expect(body.user.permissions).toEqual([]);
    const token = body.access_token;

    // Chưa chọn vai trò → MembershipGuard chặn onboarding.
    expect((await journey.getOnboarding(token)).statusCode).toBe(403);

    // Chọn vai trò Giáo viên: tenant + membership tenant_owner (US-0.10 AC2).
    const ws = await journey.chooseTeacher(token);
    expect(ws.statusCode).toBe(201);

    const first = await journey.getOnboarding(token);
    expect(first.statusCode).toBe(200);
    expect(first.json().steps.map((s: { step: string }) => s.step)).toEqual([
      'create_class',
      'add_students',
      'set_schedule',
      'payout_account',
      'compliance_checklist',
    ]);
    expect(first.json().currentStep).toBe('create_class');

    // Đánh dấu done tuần tự: currentStep nhảy sang bước kế, hết bước thì null.
    const steps = [
      'create_class',
      'add_students',
      'set_schedule',
      'payout_account',
      'compliance_checklist',
    ] as const;
    for (let i = 0; i < steps.length; i++) {
      const res = await journey.patchStep(token, steps[i]!, 'done');
      expect(res.statusCode).toBe(200);
      expect(res.json().currentStep).toBe(steps[i + 1] ?? null);
    }
    expect(journey.statusesOf(await journey.getOnboarding(token))).toEqual({
      create_class: 'done',
      add_students: 'done',
      set_schedule: 'done',
      payout_account: 'done',
      compliance_checklist: 'done',
    });
  });

  it('negative: OTP sai → 401 OTP_INVALID kèm attemptsLeft', async () => {
    const email = `gv.${randomUUID().slice(0, 8)}@example.com`;
    await journey.sendOtp(email);
    const code = await journey.lastCode(email);

    const res = await journey.login(email, journey.wrongCodeOf(code));
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('OTP_INVALID');
    expect(res.json().details).toEqual({ attemptsLeft: 4 });
  });

  it('boundary: OTP sai 5 lần → attemptsLeft giảm 4,3,2,1 rồi OTP_LOCKED 15 phút', async () => {
    const email = `gv.${randomUUID().slice(0, 8)}@example.com`;
    await journey.sendOtp(email);
    const code = await journey.lastCode(email);

    for (let i = 0; i < 4; i++) {
      const res = await journey.login(email, journey.wrongCodeOf(code));
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('OTP_INVALID');
      expect(res.json().details).toEqual({ attemptsLeft: 4 - i });
    }

    const fifth = await journey.login(email, journey.wrongCodeOf(code));
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({
      code: 'OTP_LOCKED',
      details: { retryAfterSec: 900 },
    });
    expect(fifth.headers['retry-after']).toBe('900');

    // Đang khóa thì mã đúng cũng bị chặn (US-0.1 AC3).
    const during = await journey.login(email, code);
    expect(during.json().code).toBe('OTP_LOCKED');
  });

  it('boundary: gửi lại OTP trước hạn 60 giây → 429 RATE_LIMITED kèm retryAfterSec', async () => {
    const email = `gv.${randomUUID().slice(0, 8)}@example.com`;
    expect((await journey.sendOtp(email)).statusCode).toBe(204);

    const res = await journey.sendOtp(email);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
    expect(res.json().details.retryAfterSec).toBeGreaterThan(0);
    expect(res.json().details.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('negative: create_class với skipped → 422, trạng thái không đổi', async () => {
    const o = await journey.teacherOwner();
    const res = await journey.patchStep(o.token, 'create_class', 'skipped');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    expect(journey.statusesOf(await journey.getOnboarding(o.token)).create_class).toBe(
      'pending',
    );
  });

  it('negative: PATCH bước không hợp lệ → 422', async () => {
    const o = await journey.teacherOwner();
    const res = await journey.patchStep(o.token, 'khong_co', 'done');
    expect(res.statusCode).toBe(422);
  });

  it('negative: thiếu Idempotency-Key → 422', async () => {
    const o = await journey.teacherOwner();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/onboarding/steps/add_students',
      payload: { status: 'done' },
      headers: { authorization: `Bearer ${o.token}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it('negative: gọi onboarding khi chưa xác thực → 401', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/onboarding' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/onboarding/steps/create_class',
          payload: { status: 'done' },
          headers: { 'idempotency-key': randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('negative: user không phải tenant_owner → 403', async () => {
    // Chưa có vai trò nào.
    const u = await journey.loginNewUser();
    expect((await journey.getOnboarding(u.token)).statusCode).toBe(403);

    // Có vai trò Phụ huynh (không gắn tenant) → vẫn không phải tenant_owner.
    const add = await app.inject({
      method: 'POST',
      url: '/v1/me/roles',
      payload: { role: 'parent' },
      headers: {
        authorization: `Bearer ${u.token}`,
        'idempotency-key': randomUUID(),
      },
    });
    expect(add.statusCode).toBe(201);
    expect((await journey.getOnboarding(u.token)).statusCode).toBe(403);
  });

  it('regression: mở lại app giữa chừng → currentStep là bước dở (US-0.2 AC3)', async () => {
    const o = await journey.teacherOwner();
    await journey.patchStep(o.token, 'create_class', 'done');
    // Bỏ qua bước 3 khi bước 2 còn dở → mở lại phải quay về bước 2.
    await journey.patchStep(o.token, 'set_schedule', 'skipped');

    const reopened = await journey.getOnboarding(o.token);
    expect(reopened.json().currentStep).toBe('add_students');
    expect(journey.statusesOf(reopened)).toMatchObject({
      create_class: 'done',
      add_students: 'pending',
      set_schedule: 'skipped',
    });
  });

  it('regression: PATCH lặp cùng Idempotency-Key → phát lại, không đổi trạng thái lần hai', async () => {
    const o = await journey.teacherOwner();
    const key = randomUUID();
    const first = await journey.patchStep(o.token, 'create_class', 'done', key);
    const again = await journey.patchStep(o.token, 'create_class', 'done', key);

    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(journey.statusesOf(again).create_class).toBe('done');
  });

  it('RLS: trạng thái onboarding của tenant A không lộ sang tenant B', async () => {
    const a = await journey.teacherOwner();
    const b = await journey.teacherOwner();

    await journey.patchStep(a.token, 'create_class', 'done');
    await journey.patchStep(a.token, 'add_students', 'skipped');

    // B chưa đụng gì: vẫn ở bước đầu, không thấy bước đã xử lý của A.
    const bView = await journey.getOnboarding(b.token);
    expect(bView.json().currentStep).toBe('create_class');
    expect(journey.statusesOf(bView)).toMatchObject({
      create_class: 'pending',
      add_students: 'pending',
    });

    // PATCH của B không làm đổi trạng thái của A.
    await journey.patchStep(b.token, 'create_class', 'done');
    expect(journey.statusesOf(await journey.getOnboarding(a.token))).toMatchObject(
      { create_class: 'done', add_students: 'skipped' },
    );

    // Lưu trực tiếp: tenant B chỉ ghi đúng một bước.
    const { rows } = await worker.query(
      `select settings #> '{onboarding,steps}' s from tenants where id = $1`,
      [b.tenantId],
    );
    expect(rows[0].s).toEqual({ create_class: 'done' });
  });
});
