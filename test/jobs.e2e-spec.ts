import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { GenerateSessionsJob } from '../libs/modules/schedule/application/generate-sessions.job.js';
import type {
  JobRuns,
  PurgeIdempotencyKeysJob,
} from '../libs/infra/src/job-runs.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant } from './support/seed.js';

const DAY = 86_400_000;

// S2-BE-09 (job đêm sinh buổi cuốn chiếu) + dọn idempotency_keys: chạy bằng role teachhub_worker như `worker`.
describe('job nền của worker', () => {
  let t: TestApp;
  let pool: pg.Pool;
  let generate: GenerateSessionsJob;
  let purge: PurgeIdempotencyKeysJob;
  let runs: JobRuns;

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const addClass = async (
    tenantId: string,
    branchId: string,
    over: { endDate?: string | null; status?: string } = {},
  ) => {
    const id = randomUUID();
    await q(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, end_date, status)
       values ($1, $2, $3, 'Lớp job', 'Toán', 9, 'online', '2030-01-01', $4, $5)`,
      [id, tenantId, branchId, over.endDate ?? null, over.status ?? 'active'],
    );
    return id;
  };
  const addRule = (
    tenantId: string,
    classId: string,
    weekday: number,
    startTime = '01:00',
  ) =>
    q(
      `insert into schedule_rules (id, tenant_id, class_id, weekday, start_time, duration_min)
       values ($1, $2, $3, $4, $5, 60)`,
      [randomUUID(), tenantId, classId, weekday, startTime],
    );

  beforeAll(async () => {
    t = await startTestApp();
    // Import sau khi startTestApp đặt biến môi trường (CoreModule kiểm env lúc nạp).
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns, PurgeIdempotencyKeysJob } =
      await import('../libs/infra/src/job-runs.js');
    const { GenerateSessionsJob } =
      await import('../libs/modules/schedule/application/generate-sessions.job.js');
    const { ScheduleService } =
      await import('../libs/modules/schedule/application/schedule.service.js');
    pool = new pg.Pool({ connectionString: t.db.url('teachhub_worker') });
    const tx = new TxService(drizzle(pool, { schema, casing: 'snake_case' }));
    runs = new JobRuns(tx);
    generate = new GenerateSessionsJob(tx, new ScheduleService(), runs);
    purge = new PurgeIdempotencyKeysJob(tx, runs);
  }, 180_000);
  afterAll(async () => {
    await pool?.end();
    await t?.stop();
  });

  it('nối dài cuốn chiếu 8 tuần; chạy lại không sinh trùng; ghi job_runs', async () => {
    const A = await seedTenant(t.worker);
    const id = await addClass(A.tenantId, A.branchId);
    await addRule(A.tenantId, id, 2, '18:00');
    await addRule(A.tenantId, id, 4, '18:00');
    const now = new Date('2030-01-01T00:00:00Z'); // thứ Ba 07:00 giờ VN

    expect(await generate.run(now)).toBe(16);
    const after1 = await q(
      `select count(*)::int n from sessions where class_id = $1`,
      [id],
    );
    expect(after1[0].n).toBe(16);

    // 4 tuần sau: cửa sổ cuốn chiếu dịch 28 ngày → thêm đúng 8 buổi (T3 + T5)
    const later = new Date(now.getTime() + 28 * DAY);
    expect(await generate.run(later)).toBe(8);
    expect(
      (
        await q(`select count(*)::int n from sessions where class_id = $1`, [
          id,
        ])
      )[0].n,
    ).toBe(24);
    // chạy lại: 0 buổi mới, không trùng (lớp, ngày, giờ)
    const again = await generate.run(later);
    expect(again).toBe(0);
    const dup = await q(
      `select count(*)::int n, count(distinct (session_date, starts_at))::int u from sessions where class_id = $1`,
      [id],
    );
    expect(dup[0]).toEqual({ n: 24, u: 24 });

    const log = await q(
      `select status, rows_affected, finished_at is not null as done from job_runs where job = 'schedule.generate-sessions' order by started_at`,
    );
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(log.every((r) => r.status === 'succeeded' && r.done)).toBe(true);
    expect(log.at(-1)!.rows_affected).toBe(0);
  });

  it('"hôm nay" theo múi giờ từng tenant; lớp lưu trữ hoặc có ngày kết thúc gần không bị đụng', async () => {
    const [HCM, KIRI] = [
      await seedTenant(t.worker),
      await seedTenant(t.worker),
    ];
    await q(
      `update tenants set timezone = 'Pacific/Kiritimati' where id = $1`,
      [KIRI.tenantId],
    );
    const mk = async (s: typeof HCM, over = {}) => {
      const id = await addClass(s.tenantId, s.branchId, over);
      for (let d = 1; d <= 7; d++) await addRule(s.tenantId, id, d); // 01:00 mọi ngày
      return id;
    };
    const [cH, cK] = [await mk(HCM), await mk(KIRI)];
    const archived = await mk(HCM, { status: 'archived' });
    const ended = await mk(HCM, { endDate: '2030-01-20' });

    // 12:00 UTC ngày 10/01: Hồ Chí Minh 19:00 ngày 10, Kiritimati (+14) 02:00 ngày 11.
    await generate.run(new Date('2030-01-10T12:00:00Z'));
    const first = async (id: string) =>
      (
        await q(
          `select min(session_date)::text d from sessions where class_id = $1`,
          [id],
        )
      )[0].d;
    expect(await first(cH)).toBe('2030-01-11'); // 01:00 ngày 10 đã qua
    expect(await first(cK)).toBe('2030-01-12'); // 01:00 ngày 11 giờ Kiritimati đã qua
    for (const id of [archived, ended]) {
      expect(
        (
          await q(`select count(*)::int n from sessions where class_id = $1`, [
            id,
          ])
        )[0].n,
      ).toBe(0);
    }
    // mọi buổi sinh ra thuộc đúng tenant của lớp
    expect(
      (
        await q(
          `select count(*)::int n from sessions s join classes c on c.id = s.class_id where s.tenant_id <> c.tenant_id`,
        )
      )[0].n,
    ).toBe(0);
  });

  it('job lỗi: job_runs ghi failed kèm lỗi, ném lại để BullMQ thử lại', async () => {
    await expect(
      runs.track('test.fail', () =>
        Promise.reject(new Error('hỏng giữa chừng')),
      ),
    ).rejects.toThrow('hỏng giữa chừng');
    expect(
      (
        await q(`select status, error from job_runs where job = 'test.fail'`)
      )[0],
    ).toEqual({ status: 'failed', error: 'hỏng giữa chừng' });
  });

  it('dọn idempotency_keys: xóa bản ghi quá 48 giờ, giữ bản mới, ghi job_runs', async () => {
    const A = await seedTenant(t.worker);
    const old = randomUUID();
    const fresh = randomUUID();
    for (const [key, hours] of [
      [old, 49],
      [fresh, 47],
    ] as const) {
      await q(
        `insert into idempotency_keys (id, user_id, endpoint, key, request_hash, status_code, created_at)
         values ($1, $2, 'POST /x', $3, 'h', 201, now() - make_interval(hours => $4))`,
        [randomUUID(), A.userId, key, hours],
      );
    }
    expect(await purge.run()).toBeGreaterThanOrEqual(1);
    const left = (
      await q(`select key from idempotency_keys where user_id = $1`, [A.userId])
    ).map((r) => r.key);
    expect(left).toEqual([fresh]);
    expect(
      (
        await q(
          `select status from job_runs where job = 'infra.purge-idempotency-keys'`,
        )
      )[0].status,
    ).toBe('succeeded');
  });
});
