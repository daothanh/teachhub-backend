import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';

// S2-BE-10: GET /v1/onboarding, PATCH /v1/onboarding/steps/{step} (US-0.2).
describe('Onboarding', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let worker: pg.Pool;
  let app: NestFastifyApplication;

  type Owner = { userId: string; token: string; tenantId: string };

  const owner = async (withWorkspace = true): Promise<Owner> => {
    const email = `co.lan.${randomUUID().slice(0, 8)}@example.com`;
    const userId = await app
      .get(TxService)
      .run(
        { userId: null },
        async (t) =>
          (
            await t.execute<{ id: string }>(
              sql`select app_private.sign_in_identity('email', ${email}, ${email}, ${randomUUID()}, ${randomUUID()}) as id`,
            )
          ).rows[0]!.id,
      );
    const { SessionService } =
      await import('../libs/modules/auth/session/session.service.js');
    const token = (await app.get(SessionService).open(userId)).access_token;
    let tenantId = '';
    if (withWorkspace) {
      const ws = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: {},
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': randomUUID(),
        },
      });
      tenantId = ws.json().tenantId;
    }
    return { userId, token, tenantId };
  };
  const get = (o: Owner) =>
    app.inject({
      method: 'GET',
      url: '/v1/onboarding',
      headers: { authorization: `Bearer ${o.token}` },
    });
  const patch = (o: Owner, step: string, status: string, key = randomUUID()) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/onboarding/steps/${step}`,
      payload: { status },
      headers: { authorization: `Bearer ${o.token}`, 'idempotency-key': key },
    });
  type Step = { step: string; status: string };
  const statuses = (res: { json: () => { steps: Step[] } }) =>
    Object.fromEntries(res.json().steps.map((s: Step) => [s.step, s.status]));

  beforeAll(async () => {
    [db, redis] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url('teachhub_app'),
      REDIS_URL: redis.getConnectionUrl(),
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
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await worker?.end();
    await Promise.all([db?.container.stop(), redis?.stop()]);
  });

  it('tenant mới: 5 bước pending theo thứ tự, currentStep = create_class', async () => {
    const o = await owner();
    const res = await get(o);
    expect(res.statusCode).toBe(200);
    expect(res.json().steps.map((s: Step) => s.step)).toEqual([
      'create_class',
      'add_students',
      'set_schedule',
      'payout_account',
      'compliance_checklist',
    ]);
    expect(res.json().currentStep).toBe('create_class');
  });

  it('US-0.2 AC3: thoát giữa chừng → GET trả đúng bước dở', async () => {
    const o = await owner();
    expect((await patch(o, 'create_class', 'done')).statusCode).toBe(200);
    // Bỏ qua bước 3, bước 2 còn dở → mở lại app phải quay về bước 2.
    const mid = await patch(o, 'set_schedule', 'skipped');
    expect(mid.json().currentStep).toBe('add_students');
    const reopened = await get(o);
    expect(reopened.json().currentStep).toBe('add_students');
    expect(statuses(reopened)).toMatchObject({
      create_class: 'done',
      add_students: 'pending',
      set_schedule: 'skipped',
    });
  });

  it('xử lý hết 5 bước → currentStep null', async () => {
    const o = await owner();
    await patch(o, 'create_class', 'done');
    for (const s of [
      'add_students',
      'set_schedule',
      'payout_account',
      'compliance_checklist',
    ]) {
      await patch(o, s, 'skipped');
    }
    expect((await get(o)).json().currentStep).toBeNull();
  });

  it('create_class skipped → 422; trạng thái không đổi', async () => {
    const o = await owner();
    const res = await patch(o, 'create_class', 'skipped');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    expect(statuses(await get(o)).create_class).toBe('pending');
  });

  it('PATCH idempotent ghi đè: done rồi skipped rồi done; khác khóa vẫn ra cùng kết quả', async () => {
    const o = await owner();
    await patch(o, 'add_students', 'done');
    expect(statuses(await patch(o, 'add_students', 'done')).add_students).toBe(
      'done',
    );
    expect(
      statuses(await patch(o, 'add_students', 'skipped')).add_students,
    ).toBe('skipped');
    expect(statuses(await patch(o, 'add_students', 'done')).add_students).toBe(
      'done',
    );
  });

  it('cùng Idempotency-Key → phát lại; thiếu khóa → 422; step sai → 422', async () => {
    const o = await owner();
    const key = randomUUID();
    const first = await patch(o, 'create_class', 'done', key);
    const again = await patch(o, 'create_class', 'done', key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const noKey = await app.inject({
      method: 'PATCH',
      url: '/v1/onboarding/steps/add_students',
      payload: { status: 'done' },
      headers: { authorization: `Bearer ${o.token}` },
    });
    expect(noKey.statusCode).toBe(422);
    expect((await patch(o, 'khong_co', 'done')).statusCode).toBe(422);
  });

  it('giữ nguyên các khóa khác trong tenants.settings', async () => {
    const o = await owner();
    await worker.query(
      `update tenants set settings = '{"quietHours":{"from":"21:00"}}' where id = $1`,
      [o.tenantId],
    );
    await patch(o, 'create_class', 'done');
    const { rows } = await worker.query(
      `select settings from tenants where id = $1`,
      [o.tenantId],
    );
    expect(rows[0].settings).toEqual({
      quietHours: { from: '21:00' },
      onboarding: { steps: { create_class: 'done' } },
    });
  });

  it('chéo tenant: trạng thái của A không lộ sang B và PATCH của B không đổi A', async () => {
    const a = await owner();
    const b = await owner();
    await patch(a, 'create_class', 'done');
    await patch(a, 'add_students', 'skipped');
    expect((await get(b)).json().currentStep).toBe('create_class');
    expect(statuses(await get(b))).not.toMatchObject({ create_class: 'done' });
    await patch(b, 'create_class', 'done');
    expect(statuses(await get(a))).toMatchObject({
      create_class: 'done',
      add_students: 'skipped',
    });
    // Tenant của B chỉ có đúng một bước được ghi.
    const { rows } = await worker.query(
      `select settings #> '{onboarding,steps}' s from tenants where id = $1`,
      [b.tenantId],
    );
    expect(rows[0].s).toEqual({ create_class: 'done' });
  });

  it('user chưa có vai trò tenant_owner → 403; không token → 401', async () => {
    const o = await owner(false);
    expect((await get(o)).statusCode).toBe(403);
    expect((await patch(o, 'create_class', 'done')).statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/v1/onboarding' });
    expect(anon.statusCode).toBe(401);
  });
});
