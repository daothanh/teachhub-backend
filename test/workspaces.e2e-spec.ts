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

// S1-BE-08: POST /v1/workspaces (US-0.10 AC2) + Idempotency-Key (Technical Spec §5.1).
describe('POST /v1/workspaces + Idempotency-Key', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let worker: pg.Pool;
  let app: NestFastifyApplication;

  type Session = { userId: string; token: string; email: string };

  const login = async (): Promise<Session> => {
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
    const s = await app.get(SessionService).open(userId);
    return { userId, token: s.access_token, email };
  };
  const create = (s: Session, key: string | null, payload: object = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload,
      headers: {
        authorization: `Bearer ${s.token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });
  const tenantsOf = async (userId: string) =>
    (
      await worker.query(
        `select t.id, t.type, t.name from tenants t
           join memberships m on m.tenant_id = t.id and m.role = 'tenant_owner'
          where m.user_id = $1`,
        [userId],
      )
    ).rows;

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

  it('AC2: tenant giáo viên + chi nhánh mặc định + chủ tenant + gói Free trong một lần', async () => {
    const s = await login();
    const res = await create(s, randomUUID());
    expect(res.statusCode).toBe(201);
    const { tenantId, membershipId } = res.json();

    const { rows } = await worker.query(
      `select t.type, t.name, t.created_by,
              (select count(*)::int from branches b where b.tenant_id = t.id and b.is_default) branches,
              (select role from memberships m where m.id = $2) role,
              (select plan_code || '/' || status from subscriptions s where s.tenant_id = t.id) plan,
              (select memberships_version from users where id = $3) mv
         from tenants t where t.id = $1`,
      [tenantId, membershipId, s.userId],
    );
    expect(rows[0]).toEqual({
      type: 'teacher',
      name: s.email.split('@')[0],
      created_by: s.userId,
      branches: 1,
      role: 'tenant_owner',
      plan: 'free/free',
      mv: 1,
    });

    // Từ giờ user là nhân sự của tenant: đọc được tenant qua RLS, nhãn vai trò có tên không gian.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me/memberships',
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(me.json().items[0]).toMatchObject({
      id: membershipId,
      role: 'tenant_owner',
      label: `Giáo viên · ${s.email.split('@')[0]}`,
    });
  });

  it('cùng khóa, cùng payload → phát lại kết quả, header Idempotent-Replayed; 1 tenant', async () => {
    const s = await login();
    const key = randomUUID();
    const first = await create(s, key);
    const again = await create(s, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await tenantsOf(s.userId)).toHaveLength(1);
  });

  it('cùng khóa, khác payload → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const s = await login();
    const key = randomUUID();
    await create(s, key);
    const res = await create(s, key, { khac: 1 });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('khóa mới nhưng đã có không gian → 200 với không gian sẵn có (US-0.1 AC4)', async () => {
    const s = await login();
    const first = (await create(s, randomUUID())).json();
    const second = await create(s, randomUUID());
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first);
    expect(await tenantsOf(s.userId)).toHaveLength(1);
  });

  it('bấm lặp khi mạng chập chờn (đồng thời, cùng khóa hoặc khác khóa) → đúng 1 tenant', async () => {
    const s = await login();
    const key = randomUUID();
    const same = await Promise.all(
      Array.from({ length: 5 }, () => create(s, key)),
    );
    for (const r of same) {
      expect([201, 409]).toContain(r.statusCode);
      if (r.statusCode === 409) {
        expect(r.json().code).toBe('IDEMPOTENCY_IN_PROGRESS');
      }
    }
    const t = await login();
    const diff = await Promise.all(
      Array.from({ length: 5 }, () => create(t, randomUUID())),
    );
    expect(diff.map((r) => r.statusCode).filter((c) => c === 201)).toHaveLength(
      1,
    );
    expect(await tenantsOf(s.userId)).toHaveLength(1);
    expect(await tenantsOf(t.userId)).toHaveLength(1);
  });

  it('phạm vi khóa theo user: user khác dùng trùng khóa vẫn tạo không gian riêng', async () => {
    const key = randomUUID();
    const a = await login();
    const b = await login();
    const ra = await create(a, key);
    const rb = await create(b, key);
    expect([ra.statusCode, rb.statusCode]).toEqual([201, 201]);
    expect(rb.json().tenantId).not.toBe(ra.json().tenantId);
  });

  it('thiếu hoặc sai dạng Idempotency-Key → 422; không token → 401', async () => {
    const s = await login();
    for (const key of [null, 'khong-phai-uuid']) {
      const res = await create(s, key);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toHaveProperty('Idempotency-Key');
    }
    expect(await tenantsOf(s.userId)).toHaveLength(0);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: {} }))
        .statusCode,
    ).toBe(401);
  });

  it('app không tự gọi được hàm tạo không gian cho user khác (lấy user từ app.user_id)', async () => {
    const s = await login();
    const err = await app
      .get(TxService)
      .run({ userId: null }, (t) =>
        t.execute(
          sql`select * from app_private.create_teacher_workspace(${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()})`,
        ),
      )
      .then(
        () => '',
        (e: Error) => (e.cause as Error).message,
      );
    expect(err).toMatch(/thiếu app.user_id/);
    expect(await tenantsOf(s.userId)).toHaveLength(0);
  });
});
