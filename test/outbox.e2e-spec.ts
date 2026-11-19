import { randomUUID } from 'node:crypto';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService, recordOutboxEvent } from '@teachhub/db';
import { OutboxCleanupService } from '../apps/worker/src/outbox/outbox-cleanup.service.js';
import { OUTBOX_MAX_ATTEMPTS } from '../apps/worker/src/outbox/outbox-policy.js';
import { OutboxRelayService } from '../apps/worker/src/outbox/outbox-relay.service.js';
import { startTestDb, type TestDb } from './containers.js';

// S3-BE-04: outbox_events ghi cùng giao dịch + relay (claim lease, SKIP LOCKED) → BullMQ.
describe('outbox', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let appPool: pg.Pool;
  /** teachhub_worker (BYPASSRLS): dựng dữ liệu, kiểm và dọn bảng; owner bị FORCE RLS nên không thấy dòng. */
  let workerPool: pg.Pool;
  let appTx: TxService;
  let workerTx: TxService;
  let urgent: Queue;
  let events: Queue;
  const tenant = randomUUID();
  const staff = randomUUID();
  const stranger = randomUUID();

  beforeAll(async () => {
    [db, redis] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    workerPool = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    appTx = new TxService(drizzle(appPool, { casing: 'snake_case' }));
    workerTx = new TxService(drizzle(workerPool, { casing: 'snake_case' }));
    await workerPool.query(`insert into users (id) values ($1), ($2)`, [
      staff,
      stranger,
    ]);
    await workerPool.query(
      `insert into tenants (id, type, name) values ($1, 'teacher', 'Lớp A')`,
      [tenant],
    );
    await workerPool.query(
      `insert into memberships (id, user_id, role, tenant_id) values ($1, $2, 'teacher', $3)`,
      [randomUUID(), staff, tenant],
    );
    const connection = {
      url: redis.getConnectionUrl(),
      maxRetriesPerRequest: null,
    };
    urgent = new Queue('urgent', { connection });
    events = new Queue('events', { connection });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([urgent?.close(), events?.close()]);
    await Promise.all([appPool?.end(), workerPool?.end()]);
    await Promise.all([db?.container.stop(), redis?.stop()]);
  });

  const q = async (text: string) => (await workerPool.query(text)).rows;
  const count = async (where = 'true') =>
    Number(
      (await q(`select count(*) from outbox_events where ${where}`))[0].count,
    );
  const reset = () => workerPool.query('delete from outbox_events');
  const record = (type: string, n = 1) =>
    appTx.run({ userId: staff }, async (tx) => {
      for (let i = 0; i < n; i++)
        await recordOutboxEvent(tx, { tenantId: tenant, type, payload: { i } });
    });
  const relay = (urgentQ = urgent, eventsQ = events) =>
    new OutboxRelayService(workerTx, urgentQ, eventsQ);
  /** Queue giả: `add` do test quyết định, còn lại không dùng. */
  const fake = (add: (name: string) => Promise<unknown>) =>
    ({ add }) as unknown as Queue;

  it('giao dịch rollback → không có sự kiện; commit → có', async () => {
    await expect(
      appTx.run({ userId: staff }, async (tx) => {
        await recordOutboxEvent(tx, {
          tenantId: tenant,
          type: 'rolled_back',
          payload: {},
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count(`type = 'rolled_back'`)).toBe(0);

    await record('committed');
    expect(await count(`type = 'committed'`)).toBe(1);
  });

  it('RLS: ghi vào tenant lạ hoặc bởi người không phải nhân sự bị từ chối', async () => {
    const foreign = (userId: string, tenantId: string) =>
      appTx.run({ userId }, (tx) =>
        recordOutboxEvent(tx, { tenantId, type: 'x', payload: {} }),
      );
    await expect(foreign(staff, randomUUID())).rejects.toMatchObject({
      cause: { message: /row-level/ },
    });
    await expect(foreign(stranger, tenant)).rejects.toMatchObject({
      cause: { message: /row-level/ },
    });
  });

  it('api không đọc/sửa được outbox_events (chỉ INSERT)', async () => {
    await expect(appPool.query('select * from outbox_events')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appPool.query('update outbox_events set attempts = 9'),
    ).rejects.toThrow(/permission denied/);
  });

  it('hai relay song song: mỗi sự kiện lấy đúng một lần, job nằm đúng hàng đợi với payload', async () => {
    await reset();
    await urgent.obliterate({ force: true });
    await events.obliterate({ force: true });
    await record('attendance_recorded', 60);
    await record('invoice_issued', 60);
    const drain = async (r: OutboxRelayService) => {
      let total = 0;
      for (let n = -1; n !== 0;) total += n = await r.relayBatch(10);
      return total;
    };
    const [a, b] = await Promise.all([drain(relay()), drain(relay())]);
    expect(a + b).toBe(120); // tổng số lần claim = số sự kiện → không ai lấy trùng
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(await count('dispatched_at is not null')).toBe(120);
    expect(await urgent.getJobCountByTypes('waiting')).toBe(60);
    expect(await events.getJobCountByTypes('waiting')).toBe(60);

    const [row] = await q(
      `select id, tenant_id from outbox_events where type = 'invoice_issued' limit 1`,
    );
    const job = await events.getJob(row.id);
    expect(job?.name).toBe('invoice_issued');
    expect(job?.data).toMatchObject({ eventId: row.id, tenantId: tenant });
    expect(await urgent.getJob(row.id)).toBeUndefined();
  }, 60_000);

  it('một sự kiện lỗi riêng trong lô → các sự kiện khác vẫn gửi, sự kiện lỗi tăng attempts', async () => {
    await reset();
    await record('ok_a');
    await record('bad');
    await record('ok_b');
    const add = (name: string) =>
      name === 'bad'
        ? Promise.reject(new TypeError('payload hỏng'))
        : Promise.resolve();
    await relay(fake(add), fake(add)).relayBatch();
    const bad = (await q(`select * from outbox_events where type = 'bad'`))[0];
    expect(bad.dispatched_at).toBeNull();
    expect(bad.attempts).toBe(1);
    expect(await count(`type like 'ok_%' and dispatched_at is not null`)).toBe(
      2,
    );
  });

  it('Redis down (add treo → timeout): attempts không tăng, chỉ lùi lịch', async () => {
    await reset();
    await record('invoice_issued', 3);
    const r = relay(
      fake(() => new Promise(() => {})),
      fake(() => new Promise(() => {})),
    );
    r.addTimeoutMs = 100;
    expect(await r.relayBatch()).toBe(3);
    const rows = await q(
      `select attempts, dispatched_at, next_attempt_at > now() as later from outbox_events`,
    );
    expect(
      rows.every((x) => x.attempts === 0 && x.dispatched_at === null),
    ).toBe(true);
    expect(rows.every((x) => x.later)).toBe(true);
    expect(await r.relayBatch()).toBe(0); // đang lùi lịch
  });

  it('lỗi riêng quá giới hạn → failed_at, hàng urgent không bao giờ failed; requeue đưa về hàng chờ', async () => {
    await reset();
    await record('invoice_issued');
    await record('attendance_recorded');
    const broken = fake(() => Promise.reject(new TypeError('hỏng')));
    const r = relay(broken, broken);
    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS + 1; i++) {
      await r.relayBatch();
      await workerPool.query(
        'update outbox_events set next_attempt_at = now()',
      );
    }
    const byType = Object.fromEntries(
      (await q('select type, attempts, failed_at from outbox_events')).map(
        (x) => [x.type, x],
      ),
    );
    expect(byType.invoice_issued.failed_at).not.toBeNull();
    expect(byType.invoice_issued.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(byType.attendance_recorded.failed_at).toBeNull();
    expect(byType.attendance_recorded.attempts).toBe(OUTBOX_MAX_ATTEMPTS + 1);

    expect(await r.requeueFailed()).toBe(1);
    const [again] = await q(
      `select attempts, failed_at from outbox_events where type = 'invoice_issued'`,
    );
    expect(again).toEqual({ attempts: 0, failed_at: null });
  });

  it('shutdown: onModuleDestroy chờ lô đang chạy xong rồi dừng hẳn', async () => {
    await reset();
    await record('invoice_issued');
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const slow = fake(async () => {
      started();
      await new Promise((r) => setTimeout(r, 300));
    });
    const r = relay(slow, slow);
    r.onApplicationBootstrap();
    await inFlight;
    await r.onModuleDestroy();
    // Lô đang chạy đã được đánh dấu xong trước khi dừng.
    expect(await count('dispatched_at is not null')).toBe(1);
    await record('invoice_issued');
    await new Promise((res) => setTimeout(res, 1_300));
    expect(await count('dispatched_at is null')).toBe(1); // không còn vòng lặp nào chạy
  });

  it('dọn dẹp: xóa sự kiện đã gửi quá 7 ngày, giữ sự kiện mới, ghi job_runs', async () => {
    await reset();
    await record('invoice_issued', 3);
    await workerPool.query(`
      update outbox_events set dispatched_at = now() - interval '8 days'
       where id in (select id from outbox_events limit 2)`);
    const removed = await new OutboxCleanupService(workerTx).purge();
    expect(removed).toBe(2);
    expect(await count()).toBe(1);
    const [run] = await q(
      `select status, rows_affected from job_runs where job = 'outbox.cleanup' order by started_at desc limit 1`,
    );
    expect(run).toEqual({ status: 'succeeded', rows_affected: 2 });
  });
});
