import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { BillingCloseJob } from '../libs/modules/billing/application/billing-close.job.js';
import { generateInvoiceCode } from '../libs/modules/billing/domain/invoice-issue.js';
import type { StudentLedger } from '../libs/modules/billing/http/payments.schemas.js';
import type {
  Receivables,
  StudentReceivableHistory,
} from '../libs/modules/billing/http/receivables.schemas.js';
import { localDate } from '../libs/modules/schedule/domain/zoned-time.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };
type Inv = {
  id: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  carriedAmount: number;
  remainingAmount: number;
  clampedAmount: number;
  lines: { kind: string; amount: number; description: string }[];
};

// Kỳ M chốt ngày 01 tháng M+1 lúc 02:00 giờ VN.
const CLOSE_DEC = new Date('2026-12-31T19:00:00Z'); // kỳ 12/2026
const CLOSE_JAN = new Date('2027-01-31T19:00:00Z'); // kỳ 01/2027
const CLOSE_FEB = new Date('2027-02-28T19:00:00Z'); // kỳ 02/2027
const CLOSE_MAR = new Date('2027-03-31T19:00:00Z'); // kỳ 03/2027
const CLOSE_APR = new Date('2027-04-30T19:00:00Z'); // kỳ 04/2027

// S6-BE-03 + S6-BE-05: số dư chuyển kỳ kết chuyển lúc PHÁT HÀNH (US-7.6, US-3.3 AC4), sổ học viên, công nợ (US-8.3).
// Bất biến bảo toàn tiền theo học viên, kiểm sau từng bước (B, P, R, L tính từ DB, xem `invariant`):
//   Σ(dòng ngoài carry_over của hóa đơn đã phát hành chưa hủy) − Σ paid_amount của chúng = Σ max(0, total − paid − carried) + số dư sổ.
describe('carry-over: chuyển kỳ lúc phát hành, sổ học viên, công nợ', () => {
  let t: TestApp;
  let pool: pg.Pool;
  let job: BillingCloseJob;
  let A: Who;
  let B: Who;
  const today = localDate(new Date(), 'Asia/Ho_Chi_Minh');
  const shift = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const id = {
    big: randomUUID(),
    small: randomUUID(),
    tiny: randomUUID(),
    c50: randomUUID(),
    per: randomUUID(),
    per2: randomUUID(),
    s1: randomUUID(), // nợ 200.000
    s2: randomUUID(), // trả thừa 50.000
    s3: randomUUID(), // trả thừa 300.000
    s4: randomUUID(), // Dec đủ, Jan chưa thu
    s5: randomUUID(), // nợ 300.000, phụ huynh trả trước khi chốt (M1)
    sA: randomUUID(), // trả thừa 50.000, hóa đơn 20.000, điều chỉnh tay
    sB: randomUUID(), // nợ 30.000, hóa đơn 50.000, điều chỉnh tay âm
    sL: randomUUID(), // trả thừa 50.000 rồi hủy khoản đó
    sO: randomUUID(), // nợ cũ đã quá hạn 90 ngày
    sP: randomUUID(), // sửa điểm danh sau phát hành
    sQ: randomUUID(), // buổi bị hủy / xóa sau phát hành
    sV: randomUUID(), // hóa đơn cũ đã hủy
    sU: randomUUID(), // như sQ nhưng nháp kỳ 01 chốt SAU kỳ 02 (T3 rồi T2)
    sT: randomUUID(), // như sQ nhưng nháp kỳ 01 chốt sau khi có nháp kỳ 02, trước khi chốt kỳ 02 (T2 rồi T3)
    sZ: randomUUID(), // miễn giảm 100%: nháp không có phát sinh
    bStu: randomUUID(),
  };
  const sessP = [randomUUID(), randomUUID(), randomUUID()];
  const sessQ = [randomUUID(), randomUUID(), randomUUID()];
  const oldDue = shift(90);
  const cmp = (a: unknown, b: unknown) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b));

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    who: { token: string },
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      },
    });
  const get = async <T>(who: Who, url: string): Promise<T> => {
    const r = await call(who, 'GET', url);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as T;
  };
  const addStudent = (who: SeededTenant, sid: string, name: string) =>
    q(`insert into students (id, tenant_id, full_name) values ($1, $2, $3)`, [
      sid,
      who.tenantId,
      name,
    ]);
  const addClass = (
    who: SeededTenant,
    cid: string,
    name: string,
    type: string,
    fee: number,
    rules: object | null = null,
  ) =>
    q(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, fee_type, fee_amount, fee_rules)
       values ($1, $2, $3, $4, 'Toán', 9, 'online', '2026-11-01', $5, $6, $7)`,
      [
        cid,
        who.tenantId,
        who.branchId,
        name,
        type,
        fee,
        rules && JSON.stringify(rules),
      ],
    );
  const enroll = (cid: string, sid: string) =>
    q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, '2026-11-01')`,
      [randomUUID(), A.tenantId, cid, sid],
    );
  const addSession = (cid: string, sessId: string, d: string) =>
    q(
      `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, 'taught')`,
      [sessId, A.tenantId, cid, d, `${d}T11:00:00Z`, `${d}T12:00:00Z`],
    );
  const attend = (sessId: string, sid: string, status: string) =>
    q(
      `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at)
       values ($1, $2, $3, $4, $5, now())`,
      [randomUUID(), A.tenantId, sessId, sid, status],
    );
  const invoiceOf = async (sid: string, periodMonth: string) =>
    (
      await q(
        `select i.*, i.oldest_due_date::text as oldest_due_date from invoices i join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
          where i.student_id = $1 and p.period_month = $2`,
        [sid, periodMonth],
      )
    )[0];
  const api = async (sid: string, month: string) =>
    get<Inv>(A, `/invoices/${(await invoiceOf(sid, month)).id}`);
  const linesOf = (invoiceId: string) =>
    q(
      `select kind, description, amount::int, session_id from invoice_lines where invoice_id = $1 order by position`,
      [invoiceId],
    );
  const ledgerOf = (sid: string) =>
    q(
      `select kind, debit::int, credit::int, invoice_id from student_ledger where student_id = $1 order by created_at, id`,
      [sid],
    );
  const balanceOf = async (sid: string) =>
    Number(
      (
        await q(
          `select coalesce(sum(debit - credit), 0)::bigint n from student_ledger where student_id = $1`,
          [sid],
        )
      )[0].n,
    );
  const pay = (invoiceId: string, amount: number) =>
    call(A, 'POST', `/invoices/${invoiceId}/payments`, {
      amount,
      method: 'bank_transfer',
    });
  const payOk = async (invoiceId: string, amount: number) => {
    const r = await pay(invoiceId, amount);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { payment: { id: string }; remainingAmount: number };
  };
  /** Phát hành mọi nháp của kỳ trừ các học viên `except` (chọn theo `invoiceIds`). */
  const issueExcept = async (month: string, except: string[]) => {
    const rows = await q(
      `select i.id from invoices i join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
        where i.tenant_id = $1 and p.period_month = $2 and i.status = 'draft' and i.student_id <> all($3::uuid[])`,
      [A.tenantId, month, except],
    );
    const [p] = await q(
      `select id from billing_periods where tenant_id = $1 and period_month = $2`,
      [A.tenantId, month],
    );
    const r = await call(A, 'POST', `/billing-periods/${p.id}/issue`, {
      invoiceIds: rows.map((x) => x.id),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as {
      issuedCount: number;
      skipped: { invoiceId: string; reason: string }[];
    };
  };
  const issueOnly = (month: string, sid: string) =>
    issueExcept(
      month,
      Object.values(id).filter((v) => v !== sid),
    );
  const issue = async (month: string) => {
    const [p] = await q(
      `select id from billing_periods where tenant_id = $1 and period_month = $2`,
      [A.tenantId, month],
    );
    const r = await call(A, 'POST', `/billing-periods/${p.id}/issue`, {
      invoiceIds: null,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as {
      issuedCount: number;
      skipped: { invoiceId: string; reason: string }[];
    };
  };
  /** Kỳ đã chốt từ trước (không hóa đơn): job catch-up chỉ bù các kỳ SAU kỳ mới nhất đã có, để các kỳ cũ giả lập ở đây không bị bù. */
  const closedPeriod = (tenantId: string, month: string) =>
    q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date, status) values ($1, $2, $3, $3, $3, 'closed')`,
      [randomUUID(), tenantId, month],
    );
  /** Hóa đơn cũ đã phát hành, còn nợ, hạn `due` (ghi thẳng DB). */
  const mkOldInvoice = async (
    sid: string,
    month: string,
    due: string,
    total: number,
    tenantId = A.tenantId,
  ) => {
    const [period, inv, code] = [
      randomUUID(),
      randomUUID(),
      generateInvoiceCode(),
    ];
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $4, $4)`,
      [period, tenantId, month, due],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [inv, tenantId, period, sid, total],
    );
    await q(
      `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount) values ($1, $2, $3, 1, 'monthly', 'Học phí tháng', $4)`,
      [randomUUID(), tenantId, inv, total],
    );
    await q(
      `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
         payout = '{"bankBin":"970436","accountNo":"1","accountName":"A"}'::jsonb, issued_at = '2026-01-01T00:00:00Z' where id = $1`,
      [inv, code, code.replace('-', ' ')],
    );
    return inv;
  };
  /** Bất biến bảo toàn tiền theo học viên (công thức ở đầu file). */
  const invariant = async (label: string) => {
    const rows = await q(
      `select s.id,
         coalesce((select sum(l.amount) from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
                    where i.student_id = s.id and i.status not in ('draft', 'void') and l.kind <> 'carry_over'), 0)::bigint as b,
         coalesce((select sum(i.paid_amount) from invoices i where i.student_id = s.id and i.status not in ('draft', 'void')), 0)::bigint as p,
         coalesce((select sum(greatest(0, i.total_amount - i.paid_amount - i.carried_amount)) from invoices i
                    where i.student_id = s.id and i.status not in ('draft', 'void')), 0)::bigint as r,
         coalesce((select sum(g.debit - g.credit) from student_ledger g where g.student_id = s.id), 0)::bigint as l
       from students s where s.tenant_id = $1`,
      [A.tenantId],
    );
    expect(rows.length).toBeGreaterThan(5);
    // carried_amount = Σ unpaid_carried của từng hóa đơn.
    const bad = await q(
      `select i.id from invoices i where i.tenant_id = $1 and i.carried_amount <>
         coalesce((select sum(g.debit - g.credit) from student_ledger g where g.invoice_id = i.id and g.kind = 'unpaid_carried'), 0)`,
      [A.tenantId],
    );
    expect(bad, `${label} carried_amount`).toEqual([]);
    for (const r of rows)
      expect(Number(r.b) - Number(r.p), `${label} ${r.id}`).toBe(
        Number(r.r) + Number(r.l),
      );
  };
  /** Σ nợ ròng theo học viên = Σ max(0, R + L); R = Σ remainingAmount (API) hóa đơn còn nợ, L = số dư sổ. */
  const expectedOutstanding = async () => {
    const rows = await q(
      `select s.id,
         coalesce((select sum(greatest(0, i.total_amount - i.paid_amount - i.carried_amount)) from invoices i
                    where i.student_id = s.id and i.status in ('issued', 'partially_paid')), 0)::bigint as r,
         coalesce((select sum(g.debit - g.credit) from student_ledger g where g.student_id = s.id), 0)::bigint as l
       from students s where s.tenant_id = $1`,
      [A.tenantId],
    );
    const inv = await q(
      `select id from invoices where tenant_id = $1 and status in ('issued', 'partially_paid')`,
      [A.tenantId],
    );
    let api = 0;
    for (const r of inv)
      api += (await get<Inv>(A, `/invoices/${r.id}`)).remainingAmount;
    expect(api).toBe(rows.reduce((n, r) => n + Number(r.r), 0));
    return rows.reduce((n, r) => n + Math.max(0, Number(r.r) + Number(r.l)), 0);
  };

  beforeAll(async () => {
    t = await startTestApp();
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    const { BillingCloseJob } =
      await import('../libs/modules/billing/application/billing-close.job.js');
    pool = new pg.Pool({ connectionString: t.db.url('teachhub_worker') });
    const tx = new TxService(drizzle(pool, { schema, casing: 'snake_case' }));
    job = new BillingCloseJob(tx, new JobRuns(tx));
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
    await q(
      `insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary) values ($1, $2, '970436', '0011001234567', 'GV', true)`,
      [randomUUID(), A.tenantId],
    );

    await addClass(A, id.big, 'Toán 9A', 'monthly', 1_200_000);
    await addClass(A, id.small, 'Văn 9A', 'monthly', 100_000);
    await addClass(A, id.tiny, 'Sử 9A', 'monthly', 20_000);
    await addClass(A, id.c50, 'Địa 9A', 'monthly', 50_000);
    await addClass(A, id.per, 'Lý 9A', 'per_session', 100_000, {
      chargeUnexcused: false,
    });
    await addClass(A, id.per2, 'Hóa 9A', 'per_session', 100_000);
    for (const [sid, name, cls] of [
      [id.s1, 'Nợ Một', id.big],
      [id.s2, 'Thừa Hai', id.big],
      [id.s3, 'Thừa Ba', id.small],
      [id.s4, 'Đủ Bốn', id.big],
      [id.s5, 'Trả Năm', id.big],
      [id.sA, 'Điều Chỉnh A', id.tiny],
      [id.sB, 'Điều Chỉnh B', id.c50],
      [id.sL, 'Sổ Lẻ', id.small],
      [id.sO, 'Quá Hạn', id.big],
      [id.sP, 'Sửa Điểm', id.per],
      [id.sQ, 'Buổi Hủy', id.per2],
      [id.sV, 'Hủy Hóa Đơn', id.per2],
      [id.sU, 'Nháp Treo', id.per2],
      [id.sT, 'Nháp Chờ', id.per2],
    ] as const) {
      await addStudent(A, sid, name);
      await enroll(cls, sid);
    }
    await addStudent(A, id.sZ, 'Miễn Giảm');
    await q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on, fee_override)
       values ($1, $2, $3, $4, '2026-11-01', $5)`,
      [
        randomUUID(),
        A.tenantId,
        id.small,
        id.sZ,
        JSON.stringify({
          discounts: [{ kind: 'percent', percent: 100, description: 'Miễn' }],
        }),
      ],
    );
    // Lý 9A: 3 buổi tháng 12 (buổi 3 vắng không phép, lớp không tính), 1 buổi tháng 1, 1 buổi tháng 2.
    for (const [i, d] of ['2026-12-03', '2026-12-10', '2026-12-17'].entries())
      await addSession(id.per, sessP[i]!, d);
    await attend(sessP[0]!, id.sP, 'present');
    await attend(sessP[1]!, id.sP, 'present');
    await attend(sessP[2]!, id.sP, 'unexcused');
    for (const d of ['2027-01-07', '2027-02-04', '2027-02-11']) {
      const s = randomUUID();
      await addSession(id.per, s, d);
      await attend(s, id.sP, 'present');
    }
    // Hóa 9A: 3 buổi mỗi tháng 12, 1, 2 (sV chưa điểm danh → tính như có mặt).
    for (const [i, d] of ['2026-12-05', '2026-12-12', '2026-12-19'].entries()) {
      await addSession(id.per2, sessQ[i]!, d);
      await attend(sessQ[i]!, id.sQ, 'present');
    }
    for (const d of ['2027-01-06', '2027-01-13', '2027-01-20', '2027-02-03']) {
      const s = randomUUID();
      await addSession(id.per2, s, d);
      await attend(s, id.sQ, 'present');
    }
    // sO: nợ cũ 100.000 của kỳ 06/2026, hạn cách đây 90 ngày.
    await mkOldInvoice(id.sO, '2026-06-01', oldDue, 100_000);
    await closedPeriod(A.tenantId, '2026-11-01');

    await addClass(B, randomUUID(), 'Hóa B', 'monthly', 500_000);
    await addStudent(B, id.bStu, 'Của B');
  }, 180_000);
  afterAll(async () => {
    await pool?.end();
    await t?.stop();
  });

  it('kỳ 12/2026: nháp không có dòng chuyển kỳ (trừ nợ cũ của sO); phát hành, thu một phần/trả thừa; sửa điểm danh và buổi sau phát hành', async () => {
    expect(await job.run(CLOSE_DEC)).toBe(15);
    const dec = (sid: string) => invoiceOf(sid, '2026-12-01');
    for (const sid of [id.s1, id.s2, id.s3, id.s4, id.sP])
      expect(
        (await linesOf((await dec(sid)).id)).map((l) => l.kind),
      ).not.toContain('carry_over');
    // sO: nợ cũ 100.000 xem trước trong nháp, hóa đơn cũ chưa bị đụng.
    const so = await dec(id.sO);
    expect(Number(so.total_amount)).toBe(1_300_000);
    expect(
      (await linesOf(so.id)).find((l) => l.kind === 'carry_over')?.amount,
    ).toBe(100_000);
    expect((await q(`select count(*)::int n from student_ledger`))[0].n).toBe(
      0,
    );
    expect(
      (
        await q(`select coalesce(sum(carried_amount), 0)::int n from invoices`)
      )[0].n,
    ).toBe(0);

    const res = await issue('2026-12-01');
    expect(res.issuedCount).toBe(14); // sZ (không có phát sinh) bị bỏ qua
    // sO: lúc phát hành mới kết chuyển; hạn nợ cũ nhất của hóa đơn = hạn hóa đơn nguồn.
    const soInv = await dec(id.sO);
    expect(soInv.oldest_due_date).toBe(oldDue);
    expect(
      Number(
        (
          await q(
            `select carried_amount::int n from invoices where student_id = $1 and total_amount = 100000`,
            [id.sO],
          )
        )[0].n,
      ),
    ).toBe(100_000);

    expect((await pay((await dec(id.s1)).id, 1_000_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.s2)).id, 1_250_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.s3)).id, 400_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.s4)).id, 1_200_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.s5)).id, 900_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.sA)).id, 70_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.sB)).id, 20_000)).statusCode).toBe(201);
    // sL: thu 150.000 cho hóa đơn 100.000 → trả thừa 50.000 (khoản thu này sẽ bị hủy ở M4).
    await payOk((await dec(id.sL)).id, 150_000);
    expect((await pay((await dec(id.sP)).id, 200_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.sQ)).id, 300_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.sU)).id, 300_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.sT)).id, 300_000)).statusCode).toBe(201);

    // Sau phát hành: sửa vắng → có mặt (sP), hủy buổi và xóa hẳn buổi (sQ); hóa đơn của sV bị hủy.
    await q(
      `update attendance set status = 'present' where session_id = $1 and student_id = $2`,
      [sessP[2], id.sP],
    );
    await q(`update sessions set status = 'cancelled' where id = $1`, [
      sessQ[2],
    ]);
    await q(`delete from attendance where session_id = $1`, [sessQ[1]]);
    await q(`delete from sessions where id = $1`, [sessQ[1]]);
    const v = await call(A, 'POST', `/invoices/${(await dec(id.sV)).id}/void`, {
      reason: 'nhầm',
    });
    expect(v.statusCode, v.body).toBe(200);
    await invariant('sau Dec');
  });

  let jan: Record<
    string,
    { id: string; total_amount: string; clamped_amount: string }
  >;
  it('kỳ 01/2027: bản nháp chỉ XEM TRƯỚC dòng chuyển kỳ, không ghi sổ, không đụng hóa đơn cũ; điều chỉnh kỳ trước (S4)', async () => {
    const ledgerBefore = (
      await q(`select count(*)::int n from student_ledger`)
    )[0].n;
    expect(await job.run(CLOSE_JAN)).toBe(15);
    const row = (sid: string) => invoiceOf(sid, '2027-01-01');
    jan = Object.fromEntries(
      await Promise.all(
        Object.entries(id)
          .filter(([k]) => /^s[0-9A-Z]/.test(k))
          .map(async ([k, sid]) => [k, await row(sid)] as const),
      ),
    );
    // Không ghi sổ, không carried_amount ở bước tạo nháp (kết chuyển ở issue).
    expect((await q(`select count(*)::int n from student_ledger`))[0].n).toBe(
      ledgerBefore,
    );
    expect(
      (
        await q(`select coalesce(sum(carried_amount), 0)::int n from invoices`)
      )[0].n,
    ).toBe(100_000);

    // US-7.6 AC1: nợ 200.000 + phát sinh 1.200.000 → dòng nợ 200.000, tổng 1.400.000.
    expect(Number(jan.s1!.total_amount)).toBe(1_400_000);
    expect((await linesOf(jan.s1!.id)).map((l) => [l.kind, l.amount])).toEqual([
      ['monthly', 1_200_000],
      ['carry_over', 200_000],
    ]);
    // AC2: trả thừa 50.000 → dòng trừ 50.000.
    expect(Number(jan.s2!.total_amount)).toBe(1_150_000);
    expect(
      (await linesOf(jan.s2!.id)).find((l) => l.kind === 'carry_over')?.amount,
    ).toBe(-50_000);
    // AC4: tổng âm → 0 đ.
    expect(Number(jan.s3!.total_amount)).toBe(0);
    expect(Number(jan.sA!.total_amount)).toBe(0);
    expect(Number(jan.sA!.clamped_amount)).toBe(30_000);
    // Đã thu đủ: không có dòng chuyển kỳ.
    expect((await linesOf(jan.s4!.id)).map((l) => l.kind)).toEqual(['monthly']);

    // US-3.3 AC4: sửa vắng → có mặt → +100.000 ghi rõ buổi; hóa đơn cũ không đổi.
    const adj = (await linesOf(jan.sP!.id)).filter(
      (l) => l.kind === 'prev_adjustment',
    );
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({
      amount: 100_000,
      session_id: sessP[2],
      description:
        'Điều chỉnh kỳ trước: buổi 2026-12-17 (Lý 9A) tính thêm 100.000 đ',
    });
    expect(
      (await linesOf((await invoiceOf(id.sP, '2026-12-01')).id)).map(
        (l) => l.kind,
      ),
    ).not.toContain('prev_adjustment');
    // S4: buổi đã tính nay bị hủy → −100.000; buổi bị xóa hẳn → −100.000; tổng 300.000 − 200.000.
    const adjQ = (await linesOf(jan.sQ!.id)).filter(
      (l) => l.kind === 'prev_adjustment',
    );
    expect(adjQ.map((l) => [l.amount, l.session_id]).sort(cmp)).toEqual(
      [
        [-100_000, sessQ[1]],
        [-100_000, sessQ[2]],
      ].sort(cmp),
    );
    expect(Number(jan.sQ!.total_amount)).toBe(100_000);
    // Hóa đơn cũ đã hủy: không điều chỉnh, không chuyển nợ.
    expect(
      (await linesOf(jan.sV!.id)).filter(
        (l) => l.kind === 'prev_adjustment' || l.kind === 'carry_over',
      ),
    ).toEqual([]);
    // sO: số dư xem trước 100.000 đã được phát hành ở Dec nên không còn; Jan chỉ còn nợ Dec (1.3M) → xem trước 1.300.000.
    expect(
      (await linesOf(jan.sO!.id)).find((l) => l.kind === 'carry_over')?.amount,
    ).toBe(1_300_000);

    // AC-3: chạy lại không nhân đôi; hai job song song cũng vậy.
    const lines = (await q(`select count(*)::int n from invoice_lines`))[0].n;
    expect(await job.run(CLOSE_JAN)).toBe(0);
    const [a, b] = await Promise.all([job.run(CLOSE_JAN), job.run(CLOSE_JAN)]);
    expect(a + b).toBe(0);
    expect((await q(`select count(*)::int n from invoice_lines`))[0].n).toBe(
      lines,
    );
    await invariant('sau job Jan');
  });

  it('M1: nháp chưa chốt thì hóa đơn cũ vẫn thu được, nợ vẫn ở /receivables; GET nháp và danh sách nháp tính lại xem trước', async () => {
    const rec = await get<Receivables>(A, '/receivables?pageSize=100');
    expect(
      rec.items.find((i) => i.studentId === id.s1)?.outstandingAmount,
    ).toBe(200_000);
    // s5 còn nợ Dec 300.000: nháp Jan xem trước 300.000.
    const before = await get<Inv>(A, `/invoices/${jan.s5!.id}`);
    expect(before.totalAmount).toBe(1_500_000);
    expect(before.lines.find((l) => l.kind === 'carry_over')?.amount).toBe(
      300_000,
    );
    const decS5 = (await invoiceOf(id.s5, '2026-12-01')).id;
    await payOk(decS5, 300_000);
    const after = await get<Inv>(A, `/invoices/${jan.s5!.id}`);
    expect(after.totalAmount).toBe(1_200_000);
    expect(after.lines.map((l) => l.kind)).toEqual(['monthly']);
    const [p] = await q(
      `select id from billing_periods where tenant_id = $1 and period_month = '2027-01-01'`,
      [A.tenantId],
    );
    const period = await get<{
      draftTotalAmount: number;
      invoices: { items: { id: string; totalAmount: number }[] };
    }>(A, `/billing-periods/${p.id}?pageSize=100`);
    expect(
      period.invoices.items.find((i) => i.id === jan.s5!.id)?.totalAmount,
    ).toBe(1_200_000);
    expect(period.draftTotalAmount).toBe(
      period.invoices.items.reduce((n, i) => n + i.totalAmount, 0),
    );
    await invariant('sau M1');
  });

  it('M2/(a)/(b)/(c): điều chỉnh tay chỉ cộng dòng; không phát sinh → bỏ qua; credit đủ trả → chốt 0 đ paid; điều chỉnh âm vượt phát sinh → credit ở sổ', async () => {
    // sB: 50.000 + nợ 30.000 = 80.000, điều chỉnh −100.000 → xem trước 0 đ (clamped 20.000).
    expect((await api(id.sB, '2027-01-01')).totalAmount).toBe(80_000);
    const adj = await call(A, 'POST', `/invoices/${jan.sB!.id}/adjustments`, {
      amount: -100_000,
      description: 'Giảm',
      adjustmentReason: 'Hỗ trợ',
    });
    expect(adj.statusCode, adj.body).toBe(201);
    expect(adj.json()).toMatchObject({ totalAmount: 0, clampedAmount: 20_000 });
    // Phát hành kỳ 01, không chốt sA (để dành vector 20 + 50 − 40 ở kỳ 02) và sU (nháp treo).
    const res = await issueExcept('2027-01-01', [id.sA, id.sU, id.sT]);
    // (a) sZ: Σ dòng ngoài carry = 0 → bỏ qua, vẫn nháp, không ghi sổ.
    expect(res.skipped.map((x) => x.reason)).toEqual(['ZERO_AMOUNT']);
    expect(res.issuedCount).toBe(11);
    expect((await invoiceOf(id.sZ, '2027-01-01')).status).toBe('draft');
    expect(await ledgerOf(id.sZ)).toEqual([]);
    // (b) s3: phát sinh 100.000, credit 300.000 → chốt 0 đ `paid`, có mã, không QR; ghi nợ đúng phần phát sinh; dư 200.000.
    const s3 = await invoiceOf(id.s3, '2027-01-01');
    expect(s3).toMatchObject({
      status: 'paid',
      paid_amount: '0',
      qr_payload: null,
    });
    expect(s3.code).toMatch(/^TH-/);
    expect(Number(s3.total_amount)).toBe(0);
    expect(
      (await ledgerOf(id.s3)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['overpayment', 0, 300_000],
      ['applied_to_invoice', 100_000, 0],
    ]);
    expect(await balanceOf(id.s3)).toBe(-200_000);
    expect((await api(id.s3, '2027-01-01')).remainingAmount).toBe(0);
    // (c) sB: phát sinh −50.000 (50.000 − 100.000) và nợ cũ 30.000 → 0 đ paid; nợ cũ được chuyển, phần âm thành credit ở sổ.
    const sb = await invoiceOf(id.sB, '2027-01-01');
    expect(sb).toMatchObject({ status: 'paid', qr_payload: null });
    expect(Number((await invoiceOf(id.sB, '2026-12-01')).carried_amount)).toBe(
      30_000,
    );
    expect(
      (await ledgerOf(id.sB)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['unpaid_carried', 30_000, 0],
      ['applied_to_invoice', 0, 50_000],
    ]);
    expect(await balanceOf(id.sB)).toBe(-20_000);
    // Không còn nợ ở đâu: /receivables không có sB, s3.
    const rec = await get<Receivables>(A, '/receivables?pageSize=100');
    expect(
      rec.items.some((i) => ([id.sB, id.s3] as string[]).includes(i.studentId)),
    ).toBe(false);
    // Nháp treo sU, sT và sA vẫn nháp.
    for (const k of ['sA', 'sU', 'sT'] as const)
      expect((await invoiceOf(id[k], '2027-01-01')).status).toBe('draft');
    await invariant('sau issue Jan');
  });

  it('phát hành kỳ 01 kết chuyển đúng: nợ s1 (carried_amount, sổ, hạn nợ), trả thừa s2, 0 đ không đụng sổ', async () => {
    // s1: hóa đơn cũ còn nợ 0, đánh dấu đã chuyển; sổ: nợ + đối ứng, số dư 0; hạn nợ cũ nhất của hóa đơn mới = hạn hóa đơn cũ.
    const oldS1 = await invoiceOf(id.s1, '2026-12-01');
    expect(Number(oldS1.carried_amount)).toBe(200_000);
    expect((await api(id.s1, '2026-12-01')).remainingAmount).toBe(0);
    expect((await api(id.s1, '2026-12-01')).carriedAmount).toBe(200_000);
    expect(
      (await ledgerOf(id.s1)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['unpaid_carried', 200_000, 0],
      ['applied_to_invoice', 0, 200_000],
    ]);
    const janS1 = await invoiceOf(id.s1, '2027-01-01');
    expect(janS1.status).toBe('issued');
    expect(janS1.oldest_due_date).toBe('2027-01-11');
    expect((await api(id.s1, '2027-01-01')).totalAmount).toBe(1_400_000);
    // s2: trả thừa 50.000 được trừ (ghi nợ đối ứng) → số dư 0.
    expect(
      (await ledgerOf(id.s2)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['overpayment', 0, 50_000],
      ['applied_to_invoice', 50_000, 0],
    ]);
    expect((await api(id.s2, '2027-01-01')).totalAmount).toBe(1_150_000);
    // s3: đã chốt 0 đ (xem test trước), số dư còn 200.000.
    expect(await balanceOf(id.s3)).toBe(-200_000);
    // s5: phụ huynh đã trả hóa đơn cũ → không kết chuyển gì.
    expect(Number((await invoiceOf(id.s5, '2026-12-01')).carried_amount)).toBe(
      0,
    );
    expect(await ledgerOf(id.s5)).toEqual([]);
    // sO: nợ Dec 1.3M chuyển sang Jan, hạn nợ vẫn là hạn gốc (chuyển 2 kỳ liên tiếp).
    expect((await invoiceOf(id.sO, '2027-01-01')).oldest_due_date).toBe(oldDue);
    // sQ: tổng 100.000 sau điều chỉnh âm.
    expect((await api(id.sQ, '2027-01-01')).totalAmount).toBe(100_000);
    // Hóa đơn đã chuyển nợ và hóa đơn mang dòng chuyển kỳ không hủy được; ghi thêm tiền vào phần đã chuyển hết thì 409.
    const dec = await invoiceOf(id.s1, '2026-12-01');
    expect(
      (await call(A, 'POST', `/invoices/${dec.id}/void`, { reason: 'nhầm' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call(A, 'POST', `/invoices/${janS1.id}/void`, { reason: 'nhầm' }))
        .statusCode,
    ).toBe(409);
    await expect(
      q(
        `update invoices set status = 'void', voided_at = now(), void_reason = 'x' where id = $1`,
        [janS1.id],
      ),
    ).rejects.toThrow(/INVOICE_IMMUTABLE/);
    const p409 = await pay(dec.id, 100_000);
    expect(p409.statusCode, p409.body).toBe(409);
    expect(p409.json().code).toBe('INVOICE_NOT_PAYABLE');
  });

  it('M3: hủy khoản thu trên hóa đơn đã chuyển nợ → còn nợ lại đúng phần chưa chuyển và thu lại được; thu quá phần còn nợ → 422', async () => {
    const dec = await invoiceOf(id.s1, '2026-12-01');
    const pays = await get<{ items: { id: string }[] }>(
      A,
      `/invoices/${dec.id}/payments`,
    );
    const vp = await call(A, 'POST', `/payments/${pays.items[0]!.id}/void`, {
      reason: 'ghi nhầm',
    });
    expect(vp.statusCode, vp.body).toBe(200);
    // Tổng 1.2M, đã thu 0, đã chuyển 200.000 → còn 1.000.000.
    expect(vp.json()).toMatchObject({
      status: 'issued',
      paidAmount: 0,
      remainingAmount: 1_000_000,
    });
    await invariant('sau hủy thu s1');
    const over = await pay(dec.id, 1_100_000);
    expect(over.statusCode, over.body).toBe(422);
    expect(over.json().code).toBe('VALIDATION_FAILED');
    const ok = await payOk(dec.id, 1_000_000);
    expect(ok.remainingAmount).toBe(0);
    expect((await pay(dec.id, 1_000)).statusCode).toBe(409);
    await invariant('sau thu lại s1');
  });

  it('M4: hủy thanh toán có trả thừa đã áp → nợ ở sổ vào /receivables (kể cả học viên chỉ có nợ ở sổ), hạn theo hóa đơn gắn bút toán', async () => {
    // sL: Dec 100.000 thu 150.000 (trả thừa 50.000); Jan 100.000 − 50.000 = 50.000 đã phát hành; thu đủ Jan; hủy khoản thu thừa.
    const janL = await invoiceOf(id.sL, '2027-01-01');
    expect(janL.status).toBe('issued');
    expect(Number(janL.total_amount)).toBe(50_000);
    await payOk(janL.id, 50_000);
    const decL = await invoiceOf(id.sL, '2026-12-01');
    const pays = await get<{ items: { id: string }[] }>(
      A,
      `/invoices/${decL.id}/payments`,
    );
    expect(
      (
        await call(A, 'POST', `/payments/${pays.items[0]!.id}/void`, {
          reason: 'ghi nhầm',
        })
      ).statusCode,
    ).toBe(200);
    // Thu lại đúng 100.000 cho hóa đơn Dec: hóa đơn đủ, chỉ còn nợ ở sổ (50.000 trả thừa đã bị hủy mà Jan đã trừ).
    await payOk(decL.id, 100_000);
    expect(await balanceOf(id.sL)).toBe(50_000);
    const rec = await get<Receivables>(A, '/receivables?pageSize=100');
    const rowL = rec.items.find((i) => i.studentId === id.sL)!;
    expect(rowL).toMatchObject({
      outstandingAmount: 50_000,
      openInvoiceCount: 1,
      oldestDueDate: '2027-01-11',
    });
    const hist = await get<StudentReceivableHistory>(
      A,
      `/receivables/${id.sL}`,
    );
    expect(hist).toMatchObject({
      outstandingAmount: 50_000,
      ledgerBalanceAmount: 50_000,
    });
    // s2: hủy khoản thu 1.25M có trả thừa đã áp: nợ = Dec 1.2M + Jan 1.15M + sổ 50.000.
    const decS2 = await invoiceOf(id.s2, '2026-12-01');
    const p2 = await get<{ items: { id: string }[] }>(
      A,
      `/invoices/${decS2.id}/payments`,
    );
    expect(
      (
        await call(A, 'POST', `/payments/${p2.items[0]!.id}/void`, {
          reason: 'ghi nhầm',
        })
      ).statusCode,
    ).toBe(200);
    expect(await balanceOf(id.s2)).toBe(50_000);
    const rec2 = await get<Receivables>(A, '/receivables?pageSize=100');
    expect(
      rec2.items.find((i) => i.studentId === id.s2)?.outstandingAmount,
    ).toBe(1_200_000 + 1_150_000 + 50_000);
    expect(rec2.summary.totalAmount).toBe(await expectedOutstanding());
    // Trả thừa và hủy xen kẽ trên hóa đơn Dec của s2: bất biến đúng sau từng bước.
    const over = await payOk(decS2.id, 1_300_000); // trả thừa 100.000
    await invariant('s2 trả thừa');
    expect(
      (
        await call(A, 'POST', `/payments/${over.payment.id}/void`, {
          reason: 'ghi nhầm',
        })
      ).statusCode,
    ).toBe(200);
    await invariant('s2 hủy trả thừa');
    await payOk(decS2.id, 1_200_000);
    await invariant('s2 thu đủ');
    expect(
      (await get<Receivables>(A, '/receivables?pageSize=100')).summary
        .totalAmount,
    ).toBe(await expectedOutstanding());
    await invariant('sau M4');
  });

  it('kỳ 02/2027: nợ đã chuyển không chuyển lần nữa; điều chỉnh không lặp; điều chỉnh tay 20 + trả thừa 50 + 40 → phát hành 10; phát hành song song với ghi thu', async () => {
    expect(await job.run(CLOSE_FEB)).toBeGreaterThanOrEqual(12);
    const feb = (sid: string) => invoiceOf(sid, '2027-02-01');
    // s1: Dec đã chuyển hết (thu lại đủ), Jan 1.4M chưa thu → chuyển 1.4M, không 1.6M.
    expect(
      (await linesOf((await feb(id.s1)).id)).find(
        (l) => l.kind === 'carry_over',
      )?.amount,
    ).toBe(1_400_000);
    // sQ: không điều chỉnh lần hai; nợ Jan 100.000 xem trước.
    expect((await linesOf((await feb(id.sQ)).id)).map((l) => l.kind)).toEqual([
      'session',
      'carry_over',
    ]);
    // sA: nháp Feb 20.000 + trả thừa 50.000 (Jan chưa phát hành, dư còn nguyên) → 0 đ; +40.000 → 10.000.
    const fa = await feb(id.sA);
    expect(Number(fa.total_amount)).toBe(0);
    const adj = await call(A, 'POST', `/invoices/${fa.id}/adjustments`, {
      amount: 40_000,
      description: 'Phụ thu',
      adjustmentReason: 'Tài liệu',
    });
    expect(adj.statusCode, adj.body).toBe(201);
    expect(adj.json()).toMatchObject({ totalAmount: 10_000, clampedAmount: 0 });

    // M5: nháp Jan và Feb của sT, sU cùng chứa hai dòng điều chỉnh kỳ trước (Jan chưa chốt).
    const adjOf = async (sid: string, m: string) =>
      (await linesOf((await invoiceOf(sid, m)).id)).filter(
        (l) => l.kind === 'prev_adjustment',
      );
    for (const sid of [id.sT, id.sU])
      for (const m of ['2027-01-01', '2027-02-01'])
        expect(await adjOf(sid, m), `${sid} ${m}`).toHaveLength(2);
    // T2 rồi T3 cho sT: chốt kỳ 01 trước.
    expect((await issueOnly('2027-01-01', id.sT)).issuedCount).toBe(1);
    // Điểm danh đổi giữa lúc tạo nháp kỳ 02 và lúc chốt: sP về lại vắng không phép (kỳ 01 đã chốt +100.000) → chốt kỳ 02 theo số mới (−100.000).
    await q(
      `update attendance set status = 'unexcused' where session_id = $1 and student_id = $2`,
      [sessP[2], id.sP],
    );

    // Phát hành song song với ghi thu hóa đơn cũ của s4 (Jan 1.2M): một trong hai thứ tự, tiền luôn bảo toàn.
    const janS4 = await invoiceOf(id.s4, '2027-01-01');
    const [p] = await q(
      `select id from billing_periods where tenant_id = $1 and period_month = '2027-02-01'`,
      [A.tenantId],
    );
    const [iss, pr] = await Promise.all([
      call(A, 'POST', `/billing-periods/${p.id}/issue`, { invoiceIds: null }),
      pay(janS4.id, 500_000),
    ]);
    expect(iss.statusCode, iss.body).toBe(200);
    expect([201, 409, 422]).toContain(pr.statusCode);
    const febS4 = await api(id.s4, '2027-02-01');
    const carry = febS4.lines.find((l) => l.kind === 'carry_over')?.amount;
    expect(carry).toBe(pr.statusCode === 201 ? 700_000 : 1_200_000);
    // sA: tổng chốt 10.000 và số dư trả thừa được trừ hết.
    expect((await api(id.sA, '2027-02-01')).totalAmount).toBe(10_000);
    expect(await balanceOf(id.sA)).toBe(0);
    expect(
      (await ledgerOf(id.sA)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['overpayment', 0, 50_000],
      ['applied_to_invoice', 50_000, 0],
    ]);
    // M5: sP chốt theo điểm danh mới; sT (T2 trước) không bị điều chỉnh lần hai ở kỳ 02; sU (T3 chốt trước) giữ cả hai dòng.
    expect(
      (await adjOf(id.sP, '2027-02-01')).map((l) => [l.amount, l.session_id]),
    ).toEqual([[-100_000, sessP[2]]]);
    expect(await adjOf(id.sT, '2027-02-01')).toEqual([]);
    expect(await adjOf(id.sT, '2027-01-01')).toHaveLength(2);
    expect(await adjOf(id.sU, '2027-02-01')).toHaveLength(2);
    // T3 rồi T2 cho sU: chốt kỳ 01 sau cùng → tính lại, không còn dòng điều chỉnh.
    expect((await issueOnly('2027-01-01', id.sU)).issuedCount).toBe(1);
    expect(await adjOf(id.sU, '2027-01-01')).toEqual([]);
    // Duy nhất hóa: không (học viên, buổi, dấu) nào bị chốt hai lần; tổng điều chỉnh đã chốt của sT, sU = −200.000.
    const dup = await q(
      `select i.student_id, l.session_id, sign(l.amount) from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
        where i.tenant_id = $1 and i.status not in ('draft', 'void') and l.kind = 'prev_adjustment'
        group by 1, 2, 3 having count(*) > 1`,
      [A.tenantId],
    );
    expect(dup).toEqual([]);
    for (const sid of [id.sT, id.sU])
      expect(
        Number(
          (
            await q(
              `select coalesce(sum(l.amount), 0)::bigint n from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
                where i.student_id = $1 and i.status not in ('draft', 'void') and l.kind = 'prev_adjustment'`,
              [sid],
            )
          )[0].n,
        ),
      ).toBe(-200_000);
    // s3: Feb 100.000 − credit 200.000 → chốt 0 đ paid, dư 100.000.
    expect(await balanceOf(id.s3)).toBe(-100_000);
    expect((await invoiceOf(id.s3, '2027-02-01')).status).toBe('paid');
    await invariant('sau Feb');
  });

  it('credit 300.000 × phát sinh 100.000: ba kỳ liên tiếp mỗi kỳ một hóa đơn paid 0 đ, credit về 0, không còn nợ; kỳ thứ 4 ra 100.000 bình thường', async () => {
    // Kỳ 01, 02 đã chốt ở trên (dư 100.000); kỳ 03 là kỳ thứ ba.
    const others = Object.values(id).filter((v) => v !== id.s3);
    expect(await job.run(CLOSE_MAR)).toBeGreaterThanOrEqual(1);
    const mar = await issueExcept('2027-03-01', others);
    expect(mar.issuedCount).toBe(1);
    for (const m of ['2027-01-01', '2027-02-01', '2027-03-01']) {
      const inv = await invoiceOf(id.s3, m);
      expect(inv, m).toMatchObject({
        status: 'paid',
        total_amount: '0',
        paid_amount: '0',
        qr_payload: null,
      });
      expect(inv.code).toMatch(/^TH-/);
      expect((await api(id.s3, m)).remainingAmount).toBe(0);
    }
    expect(await balanceOf(id.s3)).toBe(0);
    expect(
      (await ledgerOf(id.s3)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['overpayment', 0, 300_000],
      ['applied_to_invoice', 100_000, 0],
      ['applied_to_invoice', 100_000, 0],
      ['applied_to_invoice', 100_000, 0],
    ]);
    const rec = await get<Receivables>(A, '/receivables?pageSize=100');
    expect(rec.items.some((i) => i.studentId === id.s3)).toBe(false);
    await invariant('sau credit hết');
    // Kỳ 04: credit đã hết → hóa đơn 100.000 bình thường, đã phát hành, có QR.
    expect(await job.run(CLOSE_APR)).toBeGreaterThanOrEqual(1);
    expect((await issueExcept('2027-04-01', others)).issuedCount).toBe(1);
    const apr = await invoiceOf(id.s3, '2027-04-01');
    expect(apr).toMatchObject({ status: 'issued', total_amount: '100000' });
    expect(apr.qr_payload).not.toBeNull();
    expect((await linesOf(apr.id)).map((l) => l.kind)).toEqual(['monthly']);
    await invariant('sau kỳ 04');
  });

  it('S1/S2/S3: nháp không phát sinh lưu 0 và không chặn đóng kỳ; tổng job = xem trước = chốt (2 lớp, giảm cố định lớn hơn học phí); nợ ròng bù trừ số dư sổ', async () => {
    const C = await seedTenant(t.worker);
    const Ct = { ...C, token: await t.tokenFor(C.userId) };
    await q(
      `insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary) values ($1, $2, '970436', '0011001234567', 'GV', true)`,
      [randomUUID(), C.tenantId],
    );
    const [big, small, tiny] = [randomUUID(), randomUUID(), randomUUID()];
    await addClass(C, big, 'C Toán', 'monthly', 1_200_000);
    await addClass(C, small, 'C Văn', 'monthly', 100_000);
    await addClass(C, tiny, 'C Sử', 'monthly', 20_000);
    const [X, Y, W, V] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const [sid, name] of [
      [X, 'Cx Miễn'],
      [Y, 'Cy Thường'],
      [W, 'Cw Hai Lớp'],
      [V, 'Cv Bù Trừ'],
    ] as const)
      await addStudent(C, sid, name);
    const enrollC = (cid: string, sid: string, override?: object) =>
      q(
        `insert into enrollments (id, tenant_id, class_id, student_id, joined_on, fee_override) values ($1, $2, $3, $4, '2026-11-01', $5)`,
        [
          randomUUID(),
          C.tenantId,
          cid,
          sid,
          override && JSON.stringify(override),
        ],
      );
    await enrollC(small, X, {
      discounts: [{ kind: 'percent', percent: 100, description: 'Miễn' }],
    });
    await enrollC(small, Y);
    await enrollC(big, W, {
      discounts: [{ kind: 'amount', amount: 1_500_000, description: 'Giảm' }],
    });
    await enrollC(tiny, W);
    await mkOldInvoice(X, '2026-06-01', shift(5), 50_000, C.tenantId);
    const v1 = await mkOldInvoice(
      V,
      '2026-05-01',
      shift(40),
      100_000,
      C.tenantId,
    );
    await mkOldInvoice(V, '2026-04-01', shift(20), 100_000, C.tenantId);
    const pv = await call(Ct, 'POST', `/invoices/${v1}/payments`, {
      amount: 150_000,
      method: 'bank_transfer',
    });
    expect(pv.statusCode, pv.body).toBe(201);

    await closedPeriod(C.tenantId, '2027-02-01');
    expect(await job.run(CLOSE_MAR)).toBeGreaterThanOrEqual(3);
    const row = async (sid: string) =>
      (
        await q(
          `select * from invoices where tenant_id = $1 and student_id = $2 and status = 'draft'`,
          [C.tenantId, sid],
        )
      )[0];
    // S1: nháp không phát sinh (X) lưu 0, dù đang có nợ cũ xem trước 50.000.
    await expect(row(X)).resolves.toMatchObject({
      total_amount: '0',
      clamped_amount: '0',
    });
    // S3: hai lớp, giảm cố định 1.500.000 > học phí 1.200.000 → job, GET và chốt cùng tổng 20.000.
    expect(Number((await row(W)).total_amount)).toBe(20_000);
    expect(Number((await row(Y)).total_amount)).toBe(100_000);
    for (const [sid, amount] of [
      [X, 0],
      [Y, 100_000],
      [W, 20_000],
    ] as const) {
      const g = await get<Inv>(Ct, `/invoices/${(await row(sid)).id}`);
      expect(g.totalAmount, sid).toBe(amount);
    }
    const xl = await get<Inv>(Ct, `/invoices/${(await row(X)).id}`);
    expect(xl.lines.find((l) => l.kind === 'carry_over')?.amount).toBe(50_000);
    const ev = await q(
      `select payload from outbox_events where tenant_id = $1 and type = 'billing_drafts_ready'`,
      [C.tenantId],
    );
    expect(ev.map((e) => e.payload)).toMatchObject([
      { draftCount: 2, draftTotalAmount: 120_000 },
    ]);
    const [per] = await q(
      `select id from billing_periods where tenant_id = $1 and period_month = '2027-03-01'`,
      [C.tenantId],
    );
    const pd = await get<{ draftTotalAmount: number }>(
      Ct,
      `/billing-periods/${per.id}`,
    );
    expect(pd.draftTotalAmount).toBe(120_000);

    const r = await call(Ct, 'POST', `/billing-periods/${per.id}/issue`, {
      invoiceIds: null,
    });
    expect(r.statusCode, r.body).toBe(200);
    const res = r.json() as {
      issuedCount: number;
      skipped: { reason: string }[];
      invoices: { studentId: string; totalAmount: number }[];
    };
    expect(res.issuedCount).toBe(2);
    expect(res.skipped.map((x) => x.reason)).toEqual(['ZERO_AMOUNT']);
    expect(res.invoices.find((i) => i.studentId === W)?.totalAmount).toBe(
      20_000,
    );
    // Kỳ chỉ còn nháp miễn giảm 100% (học viên còn nợ cũ) → đóng.
    expect(
      (await q(`select status from billing_periods where id = $1`, [per.id]))[0]
        .status,
    ).toBe('closed');

    // S2: nợ ròng bù trừ theo học viên. V: hóa đơn còn nợ 100.000, sổ −50.000 (trả thừa) → nợ 50.000.
    const rec = await get<Receivables>(Ct, '/receivables?pageSize=100');
    const byId = Object.fromEntries(rec.items.map((i) => [i.studentId, i]));
    expect(byId[V]).toMatchObject({
      outstandingAmount: 50_000,
      openInvoiceCount: 1,
      overdueDays: 20,
    });
    expect(byId[X]?.outstandingAmount).toBe(50_000);
    expect(byId[Y]?.outstandingAmount).toBe(100_000);
    expect(byId[W]?.outstandingAmount).toBe(20_000);
    expect(rec.summary.totalAmount).toBe(50_000 + 50_000 + 100_000 + 20_000);
    const h = await get<StudentReceivableHistory>(Ct, `/receivables/${V}`);
    expect(h).toMatchObject({
      invoiceOutstandingAmount: 100_000,
      ledgerBalanceAmount: -50_000,
      outstandingAmount: 50_000,
    });
  });

  it('kỳ đóng theo giá trị tính lại khi chốt: (a) điều chỉnh lưu +50k nhưng điểm danh sửa về như cũ → bỏ qua, kỳ đóng; (b) nháp lưu 0 nhưng tính lại ra +50k → kỳ KHÔNG đóng, chốt được ở lệnh sau', async () => {
    const mkTenant = async () => {
      const T = await seedTenant(t.worker);
      const Tt = { ...T, token: await t.tokenFor(T.userId) };
      await q(
        `insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary) values ($1, $2, '970436', '0011001234567', 'GV', true)`,
        [randomUUID(), T.tenantId],
      );
      const cls = randomUUID();
      await addClass(T, cls, 'T Lý', 'per_session', 50_000, {
        chargeUnexcused: false,
      });
      const mkSession = async (d: string) => {
        const sid = randomUUID();
        await q(
          `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status) values ($1, $2, $3, $4, $5, $6, 'taught')`,
          [sid, T.tenantId, cls, d, `${d}T11:00:00Z`, `${d}T12:00:00Z`],
        );
        return sid;
      };
      const mkAtt = (sess: string, stu: string, status: string) =>
        q(
          `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at) values ($1, $2, $3, $4, $5, now())`,
          [randomUUID(), T.tenantId, sess, stu, status],
        );
      // Học viên P: hóa đơn cũ 06/2026 đã phát hành 0 đ (buổi vắng không tính); buổi tháng 3/2027 cũng vắng không tính (nháp 0 đ).
      const P = randomUUID();
      await addStudent(T, P, 'Học Viên P');
      await q(
        `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, '2026-06-01')`,
        [randomUUID(), T.tenantId, cls, P],
      );
      const s1 = await mkSession('2026-06-10');
      await mkAtt(s1, P, 'unexcused');
      const sMar = await mkSession('2027-03-10');
      await mkAtt(sMar, P, 'unexcused');
      const [per, inv] = [randomUUID(), randomUUID()];
      await q(
        `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, '2026-06-01', '2026-07-01', '2026-07-11')`,
        [per, T.tenantId],
      );
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 0)`,
        [inv, T.tenantId, per, P],
      );
      await q(
        `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount, session_id, session_date, class_name)
         values ($1, $2, $3, 1, 'session', 'Buổi 2026-06-10 (không tính)', 0, $4, '2026-06-10', 'T Lý')`,
        [randomUUID(), T.tenantId, inv, s1],
      );
      await q(
        `update invoices set status = 'issued', code = $2, transfer_note = $3, payout = '{"a":1}'::jsonb, issued_at = '2026-07-01T00:00:00Z' where id = $1`,
        [inv, generateInvoiceCode(), 'TH ABCDEF'],
      );
      return { T, Tt, P, cls, s1, mkAtt, mkSession };
    };
    const periodOf = async (T: SeededTenant) =>
      (
        await q(
          `select id, status from billing_periods where tenant_id = $1 and period_month = '2027-03-01'`,
          [T.tenantId],
        )
      )[0];

    // (a): lúc tạo nháp, buổi tháng 6 được sửa thành có mặt → điều chỉnh +50k lưu trong nháp; trước khi chốt sửa về vắng.
    const D = await mkTenant();
    await q(
      `update attendance set status = 'present' where session_id = $1 and student_id = $2`,
      [D.s1, D.P],
    );
    // (b): nháp tạo ra 0 đ (chưa sửa); học viên Q có nháp 100k thường.
    const E = await mkTenant();
    const [cm, Q] = [randomUUID(), randomUUID()];
    await addClass(E.T, cm, 'T Văn', 'monthly', 100_000);
    await addStudent(E.T, Q, 'Học Viên Q');
    await q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, '2026-11-01')`,
      [randomUUID(), E.T.tenantId, cm, Q],
    );

    for (const x of [D, E]) await closedPeriod(x.T.tenantId, '2027-02-01');
    expect(await job.run(CLOSE_MAR)).toBeGreaterThanOrEqual(3);
    const draftOf = async (T: SeededTenant, sid: string) =>
      (
        await q(
          `select * from invoices where tenant_id = $1 and student_id = $2 and status = 'draft'`,
          [T.tenantId, sid],
        )
      )[0];
    const dD = await draftOf(D.T, D.P);
    expect(Number(dD.total_amount)).toBe(50_000); // lưu +50k lúc tạo
    expect(
      (await linesOf(dD.id)).some(
        (l) => l.kind === 'prev_adjustment' && l.amount === 50_000,
      ),
    ).toBe(true);
    const dE = await draftOf(E.T, E.P);
    expect(Number(dE.total_amount)).toBe(0);

    // (a) sửa về như cũ rồi chốt: tính lại 0 → ZERO_AMOUNT; không còn nháp chốt được → kỳ đóng.
    await q(
      `update attendance set status = 'unexcused' where session_id = $1 and student_id = $2`,
      [D.s1, D.P],
    );
    const pa = await periodOf(D.T);
    const ra = await call(D.Tt, 'POST', `/billing-periods/${pa.id}/issue`, {
      invoiceIds: null,
    });
    expect(ra.statusCode, ra.body).toBe(200);
    expect(ra.json()).toMatchObject({
      issuedCount: 0,
      skipped: [{ reason: 'ZERO_AMOUNT' }],
    });
    expect((await periodOf(D.T)).status).toBe('closed');
    expect(Number((await draftOf(D.T, D.P)).total_amount)).toBe(0);
    expect(
      (await linesOf((await draftOf(D.T, D.P)).id)).some(
        (l) => l.kind === 'prev_adjustment',
      ),
    ).toBe(false);

    // (b) điểm danh sửa thành có mặt sau khi tạo nháp: chốt chỉ Q → P còn chốt được → kỳ KHÔNG đóng.
    await q(
      `update attendance set status = 'present' where session_id = $1 and student_id = $2`,
      [E.s1, E.P],
    );
    const dQ = await draftOf(E.T, Q);
    const pb = await periodOf(E.T);
    const rb = await call(E.Tt, 'POST', `/billing-periods/${pb.id}/issue`, {
      invoiceIds: [dQ.id],
    });
    expect(rb.statusCode, rb.body).toBe(200);
    expect(rb.json().issuedCount).toBe(1);
    expect((await periodOf(E.T)).status).not.toBe('closed');
    expect(Number((await draftOf(E.T, E.P)).total_amount)).toBe(50_000); // đã làm mới theo số mới
    // Lệnh sau chốt P (chỉ còn điều chỉnh +50k) → đóng kỳ.
    const rc = await call(E.Tt, 'POST', `/billing-periods/${pb.id}/issue`, {
      invoiceIds: null,
    });
    expect(rc.statusCode, rc.body).toBe(200);
    expect(rc.json()).toMatchObject({ issuedCount: 1, totalAmount: 50_000 });
    expect((await periodOf(E.T)).status).toBe('closed');
  });

  it('S2 FIFO: số dư âm bù vào hóa đơn cũ nhất trước; tuổi nợ theo hóa đơn cũ nhất còn nợ SAU bù, đếm hóa đơn còn nợ sau bù', async () => {
    const G = await seedTenant(t.worker);
    const Gt = { ...G, token: await t.tokenFor(G.userId) };
    const sid = randomUUID();
    await addStudent(G, sid, 'Gx Bù Trừ');
    // A 100k hạn cũ nhất, B 300k hạn sau, Z đã thu thừa 300k (sổ −300k).
    await mkOldInvoice(sid, '2026-04-01', shift(60), 100_000, G.tenantId);
    await mkOldInvoice(sid, '2026-05-01', shift(30), 300_000, G.tenantId);
    const z = await mkOldInvoice(
      sid,
      '2026-03-01',
      shift(90),
      100_000,
      G.tenantId,
    );
    const pz = await call(Gt, 'POST', `/invoices/${z}/payments`, {
      amount: 400_000,
      method: 'bank_transfer',
    });
    expect(pz.statusCode, pz.body).toBe(201);
    const rec = await get<Receivables>(Gt, '/receivables?pageSize=100');
    // Nợ ròng 100k; A được bù hết, B còn 100k → tuổi nợ theo hạn B (30 ngày, nhóm 0–30), 1 hóa đơn.
    expect(rec.items).toHaveLength(1);
    expect(rec.items[0]).toMatchObject({
      studentId: sid,
      outstandingAmount: 100_000,
      openInvoiceCount: 1,
      overdueDays: 30,
      agingBucket: '0-30',
    });
    expect(rec.summary.totalAmount).toBe(100_000);
    expect(
      rec.summary.buckets.map((b) => [b.agingBucket, b.studentCount]),
    ).toEqual([
      ['0-30', 1],
      ['31-60', 0],
      ['over-60', 0],
    ]);
    expect(
      (await get<Receivables>(Gt, '/receivables?agingBucket=0-30')).total,
    ).toBe(1);
    expect(
      (await get<Receivables>(Gt, '/receivables?agingBucket=31-60')).items,
    ).toEqual([]);
    const h = await get<StudentReceivableHistory>(Gt, `/receivables/${sid}`);
    expect(h).toMatchObject({
      invoiceOutstandingAmount: 400_000,
      ledgerBalanceAmount: -300_000,
      outstandingAmount: 100_000,
    });
  });

  it('S1 tuổi nợ: nợ chuyển qua 3 kỳ vẫn tính từ hạn gốc → nhóm over-60; /receivables và Σ đối soát', async () => {
    for (const m of ['2026-12-01', '2027-01-01', '2027-02-01'])
      expect((await invoiceOf(id.sO, m)).oldest_due_date, m).toBe(
        m === '2026-12-01' ? oldDue : oldDue,
      );
    const rec = await get<Receivables>(A, '/receivables?pageSize=100');
    const row = rec.items.find((i) => i.studentId === id.sO)!;
    expect(row).toMatchObject({
      oldestDueDate: oldDue,
      overdueDays: 90,
      agingBucket: 'over-60',
      openInvoiceCount: 1,
    });
    expect(rec.summary.totalAmount).toBe(await expectedOutstanding());
    expect(rec.summary.totalAmount).toBe(
      rec.summary.buckets.reduce((n, b) => n + b.totalAmount, 0),
    );
    expect(rec.total).toBe(rec.items.length);
  });

  it('công nợ: nhóm 0–30/31–60/>60, lọc classId/q/agingBucket, sắp xếp, phân trang', async () => {
    const mkOld = async (
      name: string,
      ageDays: number,
      total: number,
      month: string,
      classId?: string,
    ) => {
      const sid = randomUUID();
      await addStudent(A, sid, name);
      if (classId) await enroll(classId, sid);
      await mkOldInvoice(sid, month, shift(ageDays), total);
      await mkOldInvoice(
        sid,
        month.replace('2026', '2025'),
        shift(ageDays + 20),
        total,
      );
      return sid;
    };
    await mkOld('Khoa Mới', 5, 100_000, '2026-02-01');
    await mkOld('Lan Vừa', 25, 300_000, '2026-03-01', id.c50);
    const all0 = await get<Receivables>(A, '/receivables?pageSize=100');
    const base = (b: string) =>
      all0.summary.buckets.find((x) => x.agingBucket === b)!;
    const all = await get<Receivables>(A, '/receivables?pageSize=100');
    const row = (n: string) => all.items.find((i) => i.studentName === n);
    // Hai hóa đơn: tuổi nợ theo hóa đơn CŨ nhất (hạn = ageDays + 20 trước).
    expect(row('Khoa Mới')).toMatchObject({
      outstandingAmount: 200_000,
      openInvoiceCount: 2,
      overdueDays: 25,
      agingBucket: '0-30',
    });
    expect(row('Lan Vừa')).toMatchObject({
      agingBucket: '31-60',
      overdueDays: 45,
    });
    expect(base('0-30').studentCount).toBeGreaterThan(0);
    expect(all.summary.buckets.map((b) => b.agingBucket)).toEqual([
      '0-30',
      '31-60',
      'over-60',
    ]);

    const over = await get<Receivables>(
      A,
      '/receivables?agingBucket=over-60&pageSize=100',
    );
    expect(over.items.every((i) => i.agingBucket === 'over-60')).toBe(true);
    expect(over.items.some((i) => i.studentId === id.sO)).toBe(true);
    expect(over.summary.buckets).toEqual(all.summary.buckets);
    expect(over.total).toBe(over.items.length);
    const byClass = await get<Receivables>(A, `/receivables?classId=${id.c50}`);
    expect(byClass.items.map((i) => i.studentName).sort(cmp)).toEqual(
      ['Lan Vừa', 'Điều Chỉnh B'].sort(cmp),
    );
    expect(byClass.summary.totalAmount).toBe(
      byClass.items.reduce((n, i) => n + i.outstandingAmount, 0),
    );
    expect(
      (await get<Receivables>(A, '/receivables?q=lan%20vua')).items.map(
        (i) => i.studentName,
      ),
    ).toEqual(['Lan Vừa']);
    const asc = await get<Receivables>(
      A,
      '/receivables?sortField=studentName&sortOrder=asc&pageSize=100',
    );
    const desc = await get<Receivables>(
      A,
      '/receivables?sortField=studentName&sortOrder=desc&pageSize=100',
    );
    expect(asc.items.map((i) => i.studentId)).toEqual(
      desc.items.map((i) => i.studentId).reverse(),
    );
    const old = await get<Receivables>(
      A,
      '/receivables?sortField=overdueDays&sortOrder=desc&pageSize=100',
    );
    expect(old.items[0]?.overdueDays).toBeGreaterThanOrEqual(90);
    const amt = all.items.map((i) => i.outstandingAmount);
    expect(amt).toEqual([...amt].sort((a, b) => b - a));
    const p2 = await get<Receivables>(A, '/receivables?pageSize=2&page=2');
    expect(p2).toMatchObject({ page: 2, pageSize: 2, total: all.items.length });
    expect(p2.items).toHaveLength(2);
    expect(
      (await call(A, 'GET', '/receivables?agingBucket=61%2B')).statusCode,
    ).toBe(422);
    expect(all.summary.totalAmount).toBe(await expectedOutstanding());
  });

  it('GET /receivables/{studentId} và /students/{id}/ledger: lịch sử, số dư, bút toán, phân trang', async () => {
    const h = await get<StudentReceivableHistory>(A, `/receivables/${id.s1}`);
    expect(h).toMatchObject({
      studentId: id.s1,
      studentName: 'Nợ Một',
      ledgerBalanceAmount: 0,
      dunningEnabled: true,
    });
    // Nhắc nợ (S6-BE-04): hóa đơn phát hành qua API có lịch; hóa đơn đã chuyển nợ sang kỳ sau thì mốc bị hủy.
    expect(h.reminders.length).toBeGreaterThan(0);
    expect(h.reminders.map((r) => r.invoiceCode).every(Boolean)).toBe(true);
    expect(h.enrollments.map((e) => [e.className, e.dunningEnabled])).toEqual([
      ['Toán 9A', true],
    ]);
    expect(h.invoices.map((i) => [i.periodMonth, i.totalAmount])).toEqual([
      ['2027-02-01', 2_600_000],
      ['2027-01-01', 1_400_000],
      ['2026-12-01', 1_200_000],
    ]);
    expect(h.invoices[2]).toMatchObject({ remainingAmount: 0 });
    expect(h.payments.length).toBeGreaterThanOrEqual(1);
    const clean = await get<StudentReceivableHistory>(
      A,
      `/receivables/${id.s4}`,
    );
    expect(clean.invoices.length).toBeGreaterThan(0);
    const l = await get<StudentLedger>(A, `/students/${id.s1}/ledger`);
    expect(l).toMatchObject({
      studentId: id.s1,
      balanceAmount: 0,
      debtAmount: 0,
      creditAmount: 0,
    });
    expect(l.entries).toMatchObject({ total: 4, page: 1, pageSize: 20 });
    expect(l.entries.items.map((e) => e.kind)).toEqual([
      'applied_to_invoice',
      'unpaid_carried',
      'applied_to_invoice',
      'unpaid_carried',
    ]);
    const pg1 = await get<StudentLedger>(
      A,
      `/students/${id.s1}/ledger?pageSize=1&page=2`,
    );
    expect(pg1.entries.items).toHaveLength(1);
    expect(pg1.entries.total).toBe(4);
    const s3 = await get<StudentLedger>(A, `/students/${id.s3}/ledger`);
    expect(s3).toMatchObject({ balanceAmount: 0, creditAmount: 0 });
    expect(s3.entries.total).toBe(4);
    const fresh = randomUUID();
    await addStudent(A, fresh, 'Chưa Có Sổ');
    const empty = await get<StudentLedger>(A, `/students/${fresh}/ledger`);
    expect(empty).toMatchObject({
      balanceAmount: 0,
      entries: { items: [], total: 0 },
    });
  });

  it('DoD 6.5: Σ thanh toán còn hiệu lực = Σ paid_amount hóa đơn = Σ sổ doanh thu sau luồng chuyển kỳ', async () => {
    const [r] = await q(
      `select
         (select coalesce(sum(amount), 0)::bigint from payments where tenant_id = $1 and voided_at is null) as payments,
         (select coalesce(sum(paid_amount), 0)::bigint from invoices where tenant_id = $1) as invoices,
         (select coalesce(sum(amount), 0)::bigint from revenue_ledger where tenant_id = $1) as revenue`,
      [A.tenantId],
    );
    expect(Number(r.payments)).toBe(Number(r.invoices));
    expect(Number(r.payments)).toBe(Number(r.revenue));
    expect(Number(r.payments)).toBeGreaterThan(0);
  });

  it('ràng buộc DB 0027: carried_amount (nháp = 0, khớp sổ, paid + carried ≤ total, đối chiếu cả khi INSERT), unpaid_carried/applied hợp lệ, oldest_due_date bất biến', async () => {
    const oldS1 = await invoiceOf(id.s1, '2026-12-01');
    const draft = await invoiceOf(id.sA, '2027-01-01'); // nháp chưa chốt
    const slackStudent = randomUUID();
    await addStudent(A, slackStudent, 'Hóa Đơn Trống');
    const slackId = await mkOldInvoice(
      slackStudent,
      '2026-01-01',
      shift(3),
      100_000,
    ); // chưa thu: còn chỗ cho carried
    const slack = { id: slackId };
    await expect(
      q(`update invoices set carried_amount = 1000 where id = $1`, [slack.id]),
    ).rejects.toThrow(/INVOICE_CARRIED_MISMATCH/);
    await expect(
      q(`update invoices set carried_amount = 1000 where id = $1`, [draft.id]),
    ).rejects.toThrow(/invoices_carried_amount_check/);
    await expect(
      q(`update invoices set carried_amount = total_amount where id = $1`, [
        oldS1.id,
      ]),
    ).rejects.toThrow(/invoices_carried_amount_check/); // paid + carried > total
    await expect(
      q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount, carried_amount) values ($1, $2, $3, $4, 1000, 500)`,
        [randomUUID(), A.tenantId, draft.period_id, id.sV],
      ),
    ).rejects.toThrow(/invoices_carried_amount_check/);
    await expect(
      q(
        `insert into student_ledger (id, tenant_id, student_id, invoice_id, kind, debit, description) values ($1, $2, $3, $4, 'unpaid_carried', 1000, 'bịa')`,
        [randomUUID(), A.tenantId, id.s3, draft.id],
      ),
    ).rejects.toThrow(/LEDGER_INVALID/);
    await expect(
      q(
        `insert into student_ledger (id, tenant_id, student_id, invoice_id, kind, debit, description) values ($1, $2, $3, $4, 'unpaid_carried', 1000, 'sai học viên')`,
        [randomUUID(), A.tenantId, id.s2, oldS1.id],
      ),
    ).rejects.toThrow(/LEDGER_INVALID/);
    // QR bắt buộc với hóa đơn đã phát hành có tiền; chỉ hóa đơn 0 đ (trả bằng số dư) mới được thiếu QR.
    const [qs, qi] = [randomUUID(), randomUUID()];
    await addStudent(A, qs, 'Thiếu QR');
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 1000)`,
      [qi, A.tenantId, draft.period_id, qs],
    );
    await expect(
      q(
        `update invoices set status = 'issued', code = 'TH-QQQQQ2', transfer_note = 'TH QQQQQ2', qr_payload = null,
           payout = '{"a":1}'::jsonb, issued_at = now() where id = $1`,
        [qi],
      ),
    ).rejects.toThrow(/invoices_issue_fields_check/);
    await q(`update invoices set total_amount = 0 where id = $1`, [qi]);
    await q(
      `update invoices set status = 'issued', code = 'TH-QQQQQ2', transfer_note = 'TH QQQQQ2', qr_payload = null,
         payout = '{"a":1}'::jsonb, issued_at = now() where id = $1`,
      [qi],
    ); // hóa đơn 0 đ không cần QR
    const voided = await invoiceOf(id.sV, '2026-12-01');
    await expect(
      q(
        `insert into student_ledger (id, tenant_id, student_id, invoice_id, kind, credit, description) values ($1, $2, $3, $4, 'applied_to_invoice', 1000, 'hóa đơn hủy')`,
        [randomUUID(), A.tenantId, id.sV, voided.id],
      ),
    ).rejects.toThrow(/LEDGER_INVALID/);
    const soJan = await invoiceOf(id.sO, '2027-01-01');
    await expect(
      q(`update invoices set oldest_due_date = '2020-01-01' where id = $1`, [
        soJan.id,
      ]),
    ).rejects.toThrow(/INVOICE_IMMUTABLE/);
  });

  it('chỉ chủ tenant; 404 chéo tenant; RLS: tenant B không thấy sổ/công nợ của A', async () => {
    const teacher = await seedMember(t.worker, A.tenantId, 'teacher');
    const tw = { token: await t.tokenFor(teacher) };
    for (const url of [
      '/receivables',
      `/receivables/${id.s1}`,
      `/students/${id.s1}/ledger`,
    ])
      expect((await call(tw, 'GET', url)).statusCode, url).toBe(403);
    expect((await call(B, 'GET', `/students/${id.s1}/ledger`)).statusCode).toBe(
      404,
    );
    expect((await call(B, 'GET', `/receivables/${id.s1}`)).statusCode).toBe(
      404,
    );
    expect(
      (await call(B, 'GET', `/students/${randomUUID()}/ledger`)).statusCode,
    ).toBe(404);
    expect(await get<Receivables>(B, '/receivables')).toMatchObject({
      items: [],
      total: 0,
      summary: { totalAmount: 0 },
    });
    expect(
      (await get<Receivables>(B, `/receivables?classId=${id.big}`)).items,
    ).toEqual([]);

    const app = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [
        B.userId,
      ]);
      for (const table of ['student_ledger', 'invoices', 'payments'])
        expect(
          (
            await client.query(
              `select count(*)::int n from ${table} where tenant_id = $1`,
              [A.tenantId],
            )
          ).rows[0].n,
          table,
        ).toBe(0);
      await client.query('rollback');
    } finally {
      client.release();
      await app.end();
    }
  });
  // Chạy cuối file: toàn bộ dữ liệu chuyển kỳ/trả thừa/hủy ở trên phải qua đối soát (S6-BE-06), không lệch giả.
  it('đối soát hằng đêm không báo lệch trên dữ liệu chuyển kỳ', async () => {
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    const { BillingReconcileJob } =
      await import('../libs/modules/billing/application/billing-reconcile.job.js');
    const tx = new TxService(drizzle(pool, { schema, casing: 'snake_case' }));
    const reconcile = new BillingReconcileJob(tx, new JobRuns(tx), {
      get: () => undefined,
    } as never);
    expect(await reconcile.run()).toBe(0);
  });
});
