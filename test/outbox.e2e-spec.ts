import { randomUUID } from 'node:crypto';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import type { Queue } from 'bullmq';
import { Queue as BullQueue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService, recordOutboxEvent } from '@teachhub/db';
import { OutboxRelayService } from '../apps/worker/src/outbox/outbox-relay.service.js';
import { OUTBOX_MAX_ATTEMPTS } from '../apps/worker/src/outbox/outbox-policy.js';
import { startTestDb, type TestDb } from './containers.js';

// S3-BE-04: outbox_events ghi cùng giao dịch + relay (FOR UPDATE SKIP LOCKED) → BullMQ.
describe('outbox', () => {
  let db: TestDb;
  let redis: StartedRedisContainer;
  let appPool: pg.Pool;
  /** teachhub_worker (BYPASSRLS): kiểm/dọn bảng như worker thật; owner bị FORCE RLS nên không thấy dòng. */
  let workerPool: pg.Pool;
  let appTx: TxService;
  let workerTx: TxService;
  let urgent: Queue;
  let events: Queue;
  const tenant = randomUUID();

  beforeAll(async () => {
    [db, redis] = await Promise.all([
      startTestDb(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    workerPool = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    appTx = new TxService(drizzle(appPool, { casing: 'snake_case' }));
    workerTx = new TxService(drizzle(workerPool, { casing: 'snake_case' }));
    const connection = {
      url: redis.getConnectionUrl(),
      maxRetriesPerRequest: null,
    };
    urgent = new BullQueue('urgent', { connection });
    events = new BullQueue('events', { connection });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([urgent?.close(), events?.close()]);
    await Promise.all([appPool?.end(), workerPool?.end()]);
    await Promise.all([db?.container.stop(), redis?.stop()]);
  });

  const count = async (where = 'true') =>
    Number(
      (
        await workerPool.query(
          `select count(*) from outbox_events where ${where}`,
        )
      ).rows[0].count,
    );
  const relay = () => new OutboxRelayService(workerTx, urgent, events);

  it('giao dịch rollback → không có sự kiện; commit → có', async () => {
    await expect(
      appTx.run({ userId: randomUUID() }, async (tx) => {
        await recordOutboxEvent(tx, {
          tenantId: tenant,
          type: 'rolled_back',
          payload: {},
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count(`type = 'rolled_back'`)).toBe(0);

    await appTx.run({ userId: randomUUID() }, (tx) =>
      recordOutboxEvent(tx, {
        tenantId: tenant,
        type: 'committed',
        payload: { a: 1 },
      }),
    );
    expect(await count(`type = 'committed'`)).toBe(1);
  });

  it('api không đọc/sửa được outbox_events (chỉ INSERT)', async () => {
    await expect(appPool.query('select * from outbox_events')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appPool.query('update outbox_events set attempts = 9'),
    ).rejects.toThrow(/permission denied/);
  });

  it('hai relay chạy song song: mỗi sự kiện được lấy đúng một lần', async () => {
    await workerPool.query('delete from outbox_events');
    await appTx.run({ userId: randomUUID() }, async (tx) => {
      for (let i = 0; i < 120; i++)
        await recordOutboxEvent(tx, {
          tenantId: tenant,
          type: i % 2 ? 'attendance_recorded' : 'invoice_issued',
          payload: { i },
        });
    });
    const drain = async (r: OutboxRelayService) => {
      let total = 0;
      for (let n = -1; n !== 0;) total += n = await r.relayBatch(10);
      return total;
    };
    const [a, b] = await Promise.all([drain(relay()), drain(relay())]);
    expect(a + b).toBe(120); // tổng số lần lấy = số sự kiện → không ai lấy trùng
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(await count('dispatched_at is not null')).toBe(120);
    expect(await urgent.getJobCountByTypes('waiting')).toBe(60);
    expect(await events.getJobCountByTypes('waiting')).toBe(60);
  }, 60_000);

  it('đẩy lỗi → tăng attempts, hẹn lại; quá giới hạn → failed_at', async () => {
    await workerPool.query('delete from outbox_events');
    await appTx.run({ userId: randomUUID() }, (tx) =>
      recordOutboxEvent(tx, {
        tenantId: tenant,
        type: 'invoice_issued',
        payload: {},
      }),
    );
    const broken = {
      add: () => Promise.reject(new Error('redis down')),
    } as unknown as Queue;
    const r = new OutboxRelayService(workerTx, broken, broken);
    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) {
      expect(await r.relayBatch()).toBe(1);
      const row = (
        await workerPool.query(
          'select attempts, failed_at, last_error from outbox_events',
        )
      ).rows[0];
      expect(row.attempts).toBe(i);
      expect(row.last_error).toBe('redis down');
      expect(row.failed_at !== null).toBe(i === OUTBOX_MAX_ATTEMPTS);
      // Chưa tới hạn thử lại → lô sau trống.
      if (i < OUTBOX_MAX_ATTEMPTS) {
        expect(await r.relayBatch()).toBe(0);
        await workerPool.query(
          `update outbox_events set next_attempt_at = now()`,
        );
      }
    }
    expect(await r.relayBatch()).toBe(0);
  });
});
