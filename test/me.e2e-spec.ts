import { randomUUID } from 'node:crypto';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import type { RequestContext } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';

// S1-BE-07: /v1/me/memberships, /v1/me/active-membership, /v1/me/roles; @RequiresRole + MembershipGuard.
describe('vai trò của user: /v1/me/*, @RequiresRole', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let worker: pg.Pool;
  let app: NestFastifyApplication;
  let probe: NestFastifyApplication;

  type Session = { userId: string; token: string };

  const login = async (): Promise<Session> => {
    const email = `${randomUUID()}@example.com`;
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
    return { userId, token: s.access_token };
  };
  /** Như POST /workspaces (S1-BE-08): tenant + vai trò chủ tenant. */
  const teacherOf = async (userId: string, name: string) => {
    const tenantId = randomUUID();
    const membershipId = randomUUID();
    await worker.query(
      `insert into tenants (id, type, name) values ($1, 'teacher', $2)`,
      [tenantId, name],
    );
    await worker.query(
      `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, 'tenant_owner', $3)`,
      [membershipId, userId, tenantId],
    );
    return { tenantId, membershipId };
  };
  const call = (
    target: NestFastifyApplication,
    s: Session,
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    payload?: object,
  ) =>
    target.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${s.token}`,
        // Mỗi lần gọi một ý định mới (S1-BE-08).
        ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      },
    });

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
      // Khóa JWT cố định để app thăm dò xác minh được token của app chính.
      JWT_PRIVATE_KEY: (await import('node:crypto'))
        .generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    });
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    const { createApp } = await import('../apps/api/src/app.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // App thăm dò: route thật dùng @RequiresRole, cùng guard toàn cục và CSDL.
    const { CoreModule, Ctx, GlobalExceptionFilter } =
      await import('@teachhub/core');
    const { DbModule } = await import('@teachhub/db');
    const { AuthModule } = await import('@teachhub/modules/auth');
    const { IdentityModule, RequiresRole } =
      await import('@teachhub/modules/identity');
    const { IdempotencyModule, RedisModule, MailerModule } =
      await import('@teachhub/infra');
    @Controller('probe')
    class ProbeController {
      @Get('teacher')
      @RequiresRole('tenant_owner')
      teacher(@Ctx() ctx: RequestContext) {
        return { tenantId: ctx.tenantId };
      }
      @Get('family')
      @RequiresRole('parent', 'student')
      family(@Ctx() ctx: RequestContext) {
        return { tenantId: ctx.tenantId ?? null };
      }
    }
    @Module({
      imports: [
        CoreModule,
        DbModule.register('DATABASE_URL'),
        RedisModule,
        MailerModule,
        IdempotencyModule,
        AuthModule,
        IdentityModule,
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
    })
    class ProbeModule {}
    probe = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await probe.init();
    await probe.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await probe?.close();
    await app?.close();
    await worker?.end();
    await Promise.all([db?.container.stop(), redis?.stop()]);
  });

  it('memberships: nhãn theo vai trò, chỉ vai trò đang hoạt động, lastMembershipId', async () => {
    const s = await login();
    const empty = await call(app, s, 'GET', '/v1/me/memberships');
    expect(empty.json()).toEqual({ items: [], lastMembershipId: null });

    const { tenantId, membershipId } = await teacherOf(s.userId, 'Cô Lan');
    const parent = await call(app, s, 'POST', '/v1/me/roles', {
      role: 'parent',
    });
    expect(parent.statusCode).toBe(201);
    // Vai trò đã thu hồi (ở tenant khác) không hiện.
    const old = await teacherOf(s.userId, 'Lớp cũ');
    await worker.query(
      `update memberships set status = 'revoked' where id = $1`,
      [old.membershipId],
    );

    const res = await call(app, s, 'GET', '/v1/me/memberships');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: membershipId,
          role: 'tenant_owner',
          label: 'Giáo viên · Cô Lan',
          tenantId,
          studentId: null,
        },
        {
          id: parent.json().membershipId,
          role: 'parent',
          label: 'Phụ huynh',
          tenantId: null,
          studentId: null,
        },
      ],
      lastMembershipId: null,
    });
  });

  it('roles: gọi lặp → 200 cùng membership, không tạo trùng; tăng memberships_version', async () => {
    const s = await login();
    const first = await call(app, s, 'POST', '/v1/me/roles', {
      role: 'student',
    });
    const again = await call(app, s, 'POST', '/v1/me/roles', {
      role: 'student',
    });
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(again.json().membershipId).toBe(first.json().membershipId);
    const { rows } = await worker.query(
      `select memberships_version mv,
              (select count(*)::int from memberships where user_id = $1) n
         from users where id = $1`,
      [s.userId],
    );
    expect(rows[0]).toEqual({ mv: 1, n: 1 });
    expect(
      (await call(app, s, 'POST', '/v1/me/roles', { role: 'tenant_owner' }))
        .statusCode,
    ).toBe(422);
  });

  it('roles: vai trò đã bị thu hồi không tự kích hoạt lại → 403', async () => {
    const s = await login();
    await worker.query(
      `insert into memberships (id, user_id, role, status) values ($1, $2, 'parent', 'revoked')`,
      [randomUUID(), s.userId],
    );
    const res = await call(app, s, 'POST', '/v1/me/roles', { role: 'parent' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('active-membership: lưu vai trò của mình; vai trò người khác/đã thu hồi → 404', async () => {
    const a = await login();
    const b = await login();
    const { membershipId } = await teacherOf(a.userId, 'Cô Lan');
    const bRole = (
      await call(app, b, 'POST', '/v1/me/roles', { role: 'parent' })
    ).json().membershipId;

    expect(
      (
        await call(app, a, 'PUT', '/v1/me/active-membership', {
          membershipId,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await call(app, a, 'GET', '/v1/me/memberships')).json().lastMembershipId,
    ).toBe(membershipId);

    const cross = await call(app, a, 'PUT', '/v1/me/active-membership', {
      membershipId: bRole,
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json().code).toBe('NOT_FOUND');

    await worker.query(
      `update memberships set status = 'revoked' where id = $1`,
      [membershipId],
    );
    expect(
      (
        await call(app, a, 'PUT', '/v1/me/active-membership', {
          membershipId,
        })
      ).statusCode,
    ).toBe(404);
    // Vai trò gần nhất bị thu hồi → không trả nữa.
    expect((await call(app, a, 'GET', '/v1/me/memberships')).json()).toEqual({
      items: [],
      lastMembershipId: null,
    });
  });

  it('@RequiresRole: có vai trò → qua, gắn tenant; không có → 403; không token → 401', async () => {
    const teacher = await login();
    const { tenantId } = await teacherOf(teacher.userId, 'Thầy Nam');
    const parent = await login();
    await call(app, parent, 'POST', '/v1/me/roles', { role: 'parent' });

    const ok = await call(probe, teacher, 'GET', '/probe/teacher');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tenantId });

    const denied = await call(probe, parent, 'GET', '/probe/teacher');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('FORBIDDEN');

    expect((await call(probe, parent, 'GET', '/probe/family')).json()).toEqual({
      tenantId: null,
    });
    expect(
      (await call(probe, teacher, 'GET', '/probe/family')).statusCode,
    ).toBe(403);
    expect(
      (await probe.inject({ method: 'GET', url: '/probe/teacher' })).statusCode,
    ).toBe(401);
  });

  it('S1-BE-07b: thêm vai trò có hiệu lực ngay với token đang dùng (xóa cache)', async () => {
    const s = await login();
    // Lần đầu: chưa vai trò → 403, kết quả rỗng nằm trong cache.
    expect((await call(probe, s, 'GET', '/probe/family')).statusCode).toBe(403);
    await call(app, s, 'POST', '/v1/me/roles', { role: 'parent' });
    expect((await call(probe, s, 'GET', '/probe/family')).statusCode).toBe(200);
  });

  it('S1-BE-07b: cache theo mv — token mới sau đổi vai trò đọc dữ liệu mới', async () => {
    const { SessionService } =
      await import('../libs/modules/auth/session/session.service.js');
    const s = await login();
    const { membershipId } = await teacherOf(s.userId, 'Cô Mai');
    expect((await call(probe, s, 'GET', '/probe/teacher')).statusCode).toBe(
      200,
    );
    const cache = new Redis(redis.getConnectionUrl());
    expect(await cache.exists(`mbr:${s.userId}:0`)).toBe(1);

    // Thu hồi ngoài API (vd. quản trị): tăng mv như mọi thay đổi vai trò.
    await worker.query(
      `update memberships set status = 'revoked' where id = $1`,
      [membershipId],
    );
    await worker.query(
      `update users set memberships_version = memberships_version + 1 where id = $1`,
      [s.userId],
    );
    // Token cũ (mv 0) còn dùng cache tới hết TTL 5 phút; token mới (mv 1) thấy ngay.
    expect((await call(probe, s, 'GET', '/probe/teacher')).statusCode).toBe(
      200,
    );
    const fresh = await app.get(SessionService).open(s.userId);
    const s2 = { userId: s.userId, token: fresh.access_token };
    expect((await call(probe, s2, 'GET', '/probe/teacher')).statusCode).toBe(
      403,
    );
    expect(await cache.ttl(`mbr:${s.userId}:1`)).toBeGreaterThan(290);
    cache.disconnect();
  });

  it('không token → 401 cho mọi /me', async () => {
    for (const [method, url] of [
      ['GET', '/v1/me/memberships'],
      ['PUT', '/v1/me/active-membership'],
      ['POST', '/v1/me/roles'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
  });
});
