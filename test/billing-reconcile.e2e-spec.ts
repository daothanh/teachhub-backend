import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { BillingReconcileJob } from '../libs/modules/billing/application/billing-reconcile.job.js';
import { generateInvoiceCode } from '../libs/modules/billing/domain/invoice-issue.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S6-BE-06: job billing.reconcile đối soát hằng đêm, chỉ đọc, báo lệch qua log + webhook.
describe('billing.reconcile', () => {
  let t: TestApp;
  let workerPool: pg.Pool;
  let owner: pg.Pool;
  let server: Server;
  let webhookUrl: string;
  let received: { msg_type: string; content: { text: string } }[] = [];
  let job: BillingReconcileJob;
  let seq = 0;

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const mkJob = async (url: string | undefined) => {
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    const { BillingReconcileJob } =
      await import('../libs/modules/billing/application/billing-reconcile.job.js');
    const tx = new TxService(
      drizzle(workerPool, { schema, casing: 'snake_case' }),
    );
    return new BillingReconcileJob(tx, new JobRuns(tx), {
      get: () => url,
    } as never);
  };
  /** Hóa đơn đã phát hành + một thanh toán qua API; trả id hóa đơn và thanh toán. */
  const mkPaid = async (who: Who, total: number, amount: number) => {
    seq++;
    const stu = randomUUID();
    await q(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'HS')`,
      [stu, who.tenantId],
    );
    const period = randomUUID();
    const id = randomUUID();
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
       values ($1, $2, $3, $3, ($3::date + 9))`,
      [
        period,
        who.tenantId,
        `${2050 + Math.floor(seq / 12)}-${String((seq % 12) + 1).padStart(2, '0')}-01`,
      ],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [id, who.tenantId, period, stu, total],
    );
    const code = generateInvoiceCode();
    await q(
      `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
         payout = '{"bankBin":"970436","accountNo":"0011001234567","accountName":"NGUYEN VAN A"}'::jsonb, issued_at = now() where id = $1`,
      [id, code, code.replace('-', ' ')],
    );
    const r = await t.app.inject({
      method: 'POST',
      url: `/v1/invoices/${id}/payments`,
      payload: { amount, method: 'cash' },
      headers: {
        authorization: `Bearer ${who.token}`,
        'idempotency-key': randomUUID(),
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const pid = (r.json() as { payment: { id: string } }).payment.id;
    return { id, pid };
  };

  beforeAll(async () => {
    t = await startTestApp();
    workerPool = new pg.Pool({ connectionString: t.db.url('teachhub_worker') });
    owner = new pg.Pool({ connectionString: t.db.url('teachhub_owner') });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    job = await mkJob(webhookUrl);
  }, 180_000);
  afterAll(async () => {
    server?.close();
    await workerPool?.end();
    await owner?.end();
    await t?.stop();
  });

  it('dữ liệu khớp: không cảnh báo; lệch sổ doanh thu và paid_amount: đúng một cảnh báo cho tenant lệch, không sửa dữ liệu', async () => {
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    const [good, bad] = [await mk(), await mk()];
    await mkPaid(good, 1_000_000, 1_000_000);
    await mkPaid(good, 500_000, 700_000); // trả thừa vẫn khớp
    const p1 = await mkPaid(bad, 1_000_000, 400_000);
    const p2 = await mkPaid(bad, 800_000, 800_000);

    // Dữ liệu sạch: mọi tenant (kể cả tenant của test khác dùng chung DB) không có lệch.
    expect(await job.run()).toBe(0);
    expect(received).toHaveLength(0);

    // Cố tình làm lệch bằng owner (tắt trigger chỉ-ghi-thêm): xóa dòng sổ doanh thu và sửa paid_amount.
    const c = await owner.connect();
    try {
      await c.query('begin');
      for (const tbl of ['revenue_ledger', 'invoices'])
        await c.query(`alter table ${tbl} no force row level security`);
      await c.query('alter table revenue_ledger disable trigger user');
      await c.query('alter table invoices disable trigger user');
      const d = await c.query(
        `delete from revenue_ledger where payment_id = $1`,
        [p1.pid],
      );
      expect(d.rowCount).toBe(1);
      await c.query(
        `update invoices set paid_amount = 300000, status = 'partially_paid' where id = $1`,
        [p2.id],
      );
      await c.query('alter table revenue_ledger enable trigger user');
      await c.query('alter table invoices enable trigger user');
      for (const tbl of ['revenue_ledger', 'invoices'])
        await c.query(`alter table ${tbl} force row level security`);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    const before = await q(
      `select count(*)::int n from payments where tenant_id = $1`,
      [bad.tenantId],
    );

    expect(await job.run()).toBe(1);
    expect(received).toHaveLength(1);
    const text = received[0]!.content.text;
    expect(received[0]!.msg_type).toBe('text');
    expect(text).toContain(bad.tenantId);
    expect(text).not.toContain(good.tenantId);
    expect(text).toContain(p1.pid);
    expect(text).toContain(p2.id);
    expect(
      await q(`select count(*)::int n from payments where tenant_id = $1`, [
        bad.tenantId,
      ]),
    ).toEqual(before);
    const [run] = await q(
      `select status, rows_affected from job_runs where job = 'billing.reconcile' order by started_at desc limit 1`,
    );
    expect(run).toMatchObject({ status: 'succeeded', rows_affected: 1 });
  });

  it('không có ALERT_WEBHOOK_URL: job vẫn chạy, không gửi gì; webhook lỗi không làm hỏng job', async () => {
    received = [];
    expect(await (await mkJob(undefined)).run()).toBe(1);
    expect(await (await mkJob('http://127.0.0.1:9/hook')).run()).toBe(1);
    expect(received).toHaveLength(0);
  });
});
