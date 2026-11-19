import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import * as schema from '../libs/db/src/schema/index.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S3-BE-05: POST /push/register + /push/unregister, RLS bốn bảng thông báo, job dọn thiết bị quá hạn.
describe('thiết bị push và RLS thông báo', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;
  let appPool: pg.Pool;
  let tx: TxService;

  const call = (
    who: Who,
    url: string,
    body: { userId?: string; deviceToken: string; platform?: string },
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/v1/push/${url}`,
      payload: { userId: who.userId, platform: 'android', ...body },
      headers: {
        authorization: `Bearer ${who.token}`,
        'idempotency-key': randomUUID(),
      },
    });
  const devicesOf = async (token: string) =>
    (
      await t.worker.query(
        `select user_id from devices where token = $1 order by user_id`,
        [token],
      )
    ).rows as { user_id: string }[];
  const tok = () => `tok-${randomUUID()}-${'x'.repeat(100)}`;

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    A = await mk();
    B = await mk();
    appPool = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await t?.stop();
  });

  it('đăng ký lặp cùng token → 1 dòng devices; 204', async () => {
    const token = tok();
    expect((await call(A, 'register', { deviceToken: token })).statusCode).toBe(
      204,
    );
    expect((await call(A, 'register', { deviceToken: token })).statusCode).toBe(
      204,
    );
    expect(await devicesOf(token)).toEqual([{ user_id: A.userId }]);
  });

  it('token chuyển chủ: người đăng nhập sau nhận token, bản của người trước biến mất', async () => {
    const token = tok();
    await call(A, 'register', { deviceToken: token });
    await call(B, 'register', { deviceToken: token });
    expect(await devicesOf(token)).toEqual([{ user_id: B.userId }]);
  });

  it('S2: mỗi user giữ tối đa 10 thiết bị, thiết bị cũ nhất bị xóa', async () => {
    const first = tok();
    await call(A, 'register', { deviceToken: first });
    await t.worker.query(
      `update devices set last_seen_at = now() - interval '1 day' where token = $1`,
      [first],
    );
    for (let i = 0; i < 10; i++)
      await call(A, 'register', { deviceToken: tok() });
    const n = (
      await t.worker.query(
        `select count(*)::int as n from devices where user_id = $1`,
        [A.userId],
      )
    ).rows[0].n;
    expect(n).toBe(10);
    expect(await devicesOf(first)).toEqual([]);
  });

  it('S2: token quá dài bị từ chối ở API (422) và ở CSDL (CHECK)', async () => {
    const res = await call(A, 'register', { deviceToken: 'x'.repeat(513) });
    expect(res.statusCode).toBe(422);
    await expect(
      t.worker.query(
        `insert into devices (id, user_id, token, platform) values ($1, $2, $3, 'ios')`,
        [randomUUID(), A.userId, 'x'.repeat(4097)],
      ),
    ).rejects.toThrow(/devices_token_length_check/);
  });

  it('unregister xóa bản của mình, luôn 204, không xóa token của người khác', async () => {
    const token = tok();
    await call(B, 'register', { deviceToken: token });
    expect(
      (await call(A, 'unregister', { deviceToken: token })).statusCode,
    ).toBe(204);
    expect(await devicesOf(token)).toEqual([{ user_id: B.userId }]);
    expect(
      (await call(B, 'unregister', { deviceToken: token })).statusCode,
    ).toBe(204);
    expect(await devicesOf(token)).toEqual([]);
    expect(
      (await call(B, 'unregister', { deviceToken: token })).statusCode,
    ).toBe(204);
  });

  it('chéo tenant: userId trong body khác token → 403 FORBIDDEN, không ghi gì', async () => {
    const token = tok();
    for (const url of ['register', 'unregister']) {
      const res = await call(A, url, { userId: B.userId, deviceToken: token });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
    }
    expect(await devicesOf(token)).toEqual([]);
  });

  it('RLS: devices và notifications chỉ chủ sở hữu thấy; templates/deliveries app không ghi', async () => {
    const devId = randomUUID();
    await t.worker.query(
      `insert into devices (id, user_id, token, platform) values ($1, $2, $3, 'ios')`,
      [devId, A.userId, tok()],
    );
    const count = (userId: string | null, q: ReturnType<typeof sql>) =>
      tx.run({ userId }, async (c) => (await c.execute(q)).rowCount ?? 0);
    const sel = sql`select 1 from devices where id = ${devId}`;
    expect(await count(A.userId, sel)).toBe(1);
    expect(await count(B.userId, sel)).toBe(0);
    expect(await count(null, sel)).toBe(0);
    expect(
      await count(B.userId, sql`delete from devices where id = ${devId}`),
    ).toBe(0);
    // app không UPDATE được devices (chỉ qua register_device): đổi chủ token bằng UPDATE bị chặn quyền.
    await expectInsertDenied(
      A.userId,
      sql`update devices set user_id = ${B.userId} where id = ${devId}`,
    );
    const nId = randomUUID();
    await t.worker.query(
      `insert into notifications (id, tenant_id, recipient_user_id, type, payload, dedupe_key)
       values ($1, $2, $3, 'absence_alert', '{}', 'k1')`,
      [nId, A.tenantId, A.userId],
    );
    const rows = (userId: string) =>
      tx.run(
        { userId },
        async (c) =>
          (await c.execute(sql`select id from notifications`)).rows.length,
      );
    expect(await rows(A.userId)).toBe(1);
    expect(await rows(B.userId)).toBe(0);
    await expectInsertDenied(
      A.userId,
      sql`insert into notifications (id, tenant_id, recipient_user_id, type, payload, dedupe_key)
      values (${randomUUID()}, ${A.tenantId}, ${A.userId}, 'x', '{}', 'k2')`,
    );
    await t.worker.query(
      `insert into notification_deliveries (id, notification_id, channel) values ($1, $2, 'push')`,
      [randomUUID(), nId],
    );
    await expectInsertDenied(
      A.userId,
      sql`select 1 from notification_deliveries`,
    );
    await expectInsertDenied(
      A.userId,
      sql`insert into notification_templates (id, type, channel, title_tpl, body_tpl)
      values (${randomUUID()}, 'x', 'push', 't', 'b')`,
    );
  });

  it('job dọn: xóa thiết bị quá 60 ngày không đăng ký lại, giữ thiết bị mới', async () => {
    const [oldTok, freshTok] = [tok(), tok()];
    await t.worker.query(
      `insert into devices (id, user_id, token, platform, last_seen_at) values
       ($1, $3, $4, 'ios', now() - interval '61 days'), ($2, $3, $5, 'ios', now())`,
      [randomUUID(), randomUUID(), A.userId, oldTok, freshTok],
    );
    const wTx = new TxService(
      drizzle(t.worker, { schema, casing: 'snake_case' }),
    );
    // import động: @teachhub/core kiểm env khi nạp, mà env chỉ có sau startTestApp.
    const { JobRuns } = await import('../libs/infra/src/index.js');
    const { PurgeStaleDevicesJob } =
      await import('../libs/modules/notifications/application/devices.service.js');
    const job = new PurgeStaleDevicesJob(wTx, new JobRuns(wTx));
    expect(await job.run()).toBeGreaterThanOrEqual(1);
    expect(await devicesOf(oldTok)).toEqual([]);
    expect(await devicesOf(freshTok)).toHaveLength(1);
  });

  async function expectInsertDenied(userId: string, q: ReturnType<typeof sql>) {
    const err: unknown = await tx
      .run({ userId }, (c) => c.execute(q))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const msg =
      err instanceof Error
        ? err.cause instanceof Error
          ? err.cause.message
          : err.message
        : '';
    expect(msg).toMatch(/permission denied|row-level security/);
  }
});
