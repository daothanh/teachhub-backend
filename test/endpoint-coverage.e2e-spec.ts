import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';
import { ENDPOINT_COVERAGE } from './support/endpoint-coverage.js';

type Op = { security?: unknown[] };
const contract = JSON.parse(readFileSync('contracts/openapi.json', 'utf8')) as {
  paths: Record<string, Record<string, Op>>;
};
const routes = Object.entries(contract.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({
    id: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    // Tham số đường dẫn {id} → UUID bất kỳ: guard chạy trước khi tìm tài nguyên.
    url: path.replace(/\{[^}]+\}/g, randomUUID()),
    needsToken: Boolean(op.security?.length),
  })),
);

// S1-BE-09: bảng phủ endpoint — test chéo (Plan §6.4) + test âm auth cho mọi route của hợp đồng.
describe('phủ endpoint: test chéo + test âm auth', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let worker: pg.Pool;
  let app: NestFastifyApplication;

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

  it('mọi endpoint của hợp đồng đều khai test chéo (và không khai thừa)', () => {
    expect(Object.keys(ENDPOINT_COVERAGE).sort()).toEqual(
      routes.map((r) => r.id).sort(),
    );
  });

  it.each(routes.map((r) => [r.id, ENDPOINT_COVERAGE[r.id]] as const))(
    '%s: test chéo đã khai có thật',
    (_, cover) => {
      expect(cover).toBeDefined();
      if (cover && 'file' in cover) {
        expect(readFileSync(`test/${cover.file}`, 'utf8')).toContain(
          cover.test,
        );
      }
    },
  );

  const foreignToken = () =>
    new SignJWT({ sid: 's', mv: 0 })
      .setProtectedHeader({ alg: 'ES256', kid: 'local' })
      .setSubject(randomUUID())
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);

  it.each(routes.filter((r) => r.needsToken).map((r) => [r.id, r] as const))(
    '%s: không token / token rác / token ký bằng khóa lạ → 401',
    async (_, r) => {
      for (const authorization of [
        undefined,
        'Bearer abc.def.ghi',
        `Bearer ${await foreignToken()}`,
        'Basic dXNlcjpwYXNz',
      ]) {
        const res = await app.inject({
          method: r.method,
          url: r.url,
          payload: r.method === 'GET' ? undefined : {},
          headers: authorization ? { authorization } : {},
        });
        expect(res.statusCode, String(authorization)).toBe(401);
        expect(res.json().code).toBe('UNAUTHENTICATED');
      }
    },
  );

  it.each(routes.filter((r) => !r.needsToken).map((r) => [r.id, r] as const))(
    '%s: hợp đồng ghi công khai → không đòi token',
    async (_, r) => {
      const res = await app.inject({
        method: r.method,
        url: r.url,
        payload: r.method === 'GET' ? undefined : {},
      });
      expect(res.statusCode).not.toBe(401);
    },
  );

  it('đọc dữ liệu "của tôi": token A chỉ ra dữ liệu A, token B chỉ ra B', async () => {
    const { SessionService } =
      await import('../libs/modules/auth/session/session.service.js');
    const open = async () => {
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
      const s = await app.get(SessionService).open(userId);
      return { userId, email, token: s.access_token };
    };
    const a = await open();
    const b = await open();
    const tenant = randomUUID();
    await worker.query(
      `insert into tenants (id, type, name) values ($1, 'teacher', 'Lớp của A')`,
      [tenant],
    );
    await worker.query(
      `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, 'tenant_owner', $3)`,
      [randomUUID(), a.userId, tenant],
    );
    await worker.query(
      `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
      [randomUUID(), b.userId],
    );
    const get = (token: string, url: string) =>
      app
        .inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json());

    expect(await get(a.token, '/v1/auth/me')).toMatchObject({
      id: a.userId,
      email: a.email,
      permissions: ['role:tenant_owner'],
    });
    expect(await get(b.token, '/v1/auth/me')).toMatchObject({
      id: b.userId,
      email: b.email,
      permissions: ['role:parent'],
    });
    const ma = await get(a.token, '/v1/me/memberships');
    const mb = await get(b.token, '/v1/me/memberships');
    expect(ma.items.map((m: { label: string }) => m.label)).toEqual([
      'Giáo viên · Lớp của A',
    ]);
    expect(mb.items.map((m: { label: string }) => m.label)).toEqual([
      'Phụ huynh',
    ]);
  });
});
