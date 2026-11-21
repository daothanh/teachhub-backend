import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { BillingCloseJob } from '../libs/modules/billing/application/billing-close.job.js';
import { generateInvoiceCode } from '../libs/modules/billing/domain/invoice-issue.js';
import { localDate } from '../libs/modules/schedule/domain/zoned-time.js';
import type { StudentLedger } from '../libs/modules/billing/http/payments.schemas.js';
import type {
  Receivables,
  StudentReceivableHistory,
} from '../libs/modules/billing/http/receivables.schemas.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// Kỳ M chốt ngày 01 tháng M+1 lúc 02:00 giờ VN.
const CLOSE_DEC = new Date('2026-12-31T19:00:00Z'); // kỳ 12/2026
const CLOSE_JAN = new Date('2027-01-31T19:00:00Z'); // kỳ 01/2027
const CLOSE_FEB = new Date('2027-02-28T19:00:00Z'); // kỳ 02/2027

// S6-BE-03 + S6-BE-05: số dư chuyển kỳ trong billing.close (US-7.6, US-3.3 AC4), sổ học viên, công nợ (US-8.3), đối soát.
// Mô hình: nợ kết chuyển hẳn qua sổ (xem đầu domain/carry-over.ts và billing-period.ts).
describe('carry-over: chuyển kỳ, sổ học viên, công nợ', () => {
  let t: TestApp;
  let pool: pg.Pool;
  let job: BillingCloseJob;
  let A: Who;
  let B: Who;
  const id = {
    big: randomUUID(),
    small: randomUUID(),
    per: randomUUID(),
    s1: randomUUID(), // nợ 200.000
    s2: randomUUID(), // trả thừa 50.000
    s3: randomUUID(), // trả thừa 300.000, kỳ sau chỉ phát sinh 100.000
    s4: randomUUID(), // đã thu đủ
    sP: randomUUID(), // sửa điểm danh sau phát hành
    bStu: randomUUID(),
  };
  const sessP = [randomUUID(), randomUUID(), randomUUID()];

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
  const enroll = (who: SeededTenant, cid: string, sid: string) =>
    q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, '2026-11-01')`,
      [randomUUID(), who.tenantId, cid, sid],
    );
  const addSession = async (cid: string, sessId: string, d: string) =>
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
  /** Phát hành mọi bản nháp có tiền của kỳ (ghi thẳng DB như payments.e2e-spec). */
  const issueDrafts = async (periodMonth: string) => {
    const rows = await q(
      `select i.id from invoices i join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
        where i.tenant_id = $1 and p.period_month = $2 and i.status = 'draft' and i.total_amount > 0`,
      [A.tenantId, periodMonth],
    );
    for (const r of rows) {
      const code = generateInvoiceCode();
      await q(
        `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
           payout = '{"bankBin":"970436","accountNo":"0011001234567","accountName":"NGUYEN VAN A"}'::jsonb,
           issued_at = '2026-01-01T00:00:00Z' where id = $1`,
        [r.id, code, code.replace('-', ' ')],
      );
    }
  };
  const invoiceOf = async (sid: string, periodMonth: string) =>
    (
      await q(
        `select i.* from invoices i join billing_periods p on p.tenant_id = i.tenant_id and p.id = i.period_id
          where i.student_id = $1 and p.period_month = $2`,
        [sid, periodMonth],
      )
    )[0];
  const linesOf = (invoiceId: string) =>
    q(
      `select kind, description, amount::int, session_id, position from invoice_lines where invoice_id = $1 order by position`,
      [invoiceId],
    );
  const ledgerOf = (sid: string) =>
    q(
      `select kind, debit::int, credit::int, invoice_id from student_ledger where student_id = $1 order by created_at, id`,
      [sid],
    );
  const pay = (invoiceId: string, amount: number) =>
    call(A, 'POST', `/invoices/${invoiceId}/payments`, {
      amount,
      method: 'bank_transfer',
    });
  /** Σ remainingAmount (API hóa đơn) của mọi hóa đơn còn nợ (issued/partially_paid) của tenant. */
  const sumRemaining = async () => {
    const rows = await q(
      `select id from invoices where tenant_id = $1 and status in ('issued', 'partially_paid')`,
      [A.tenantId],
    );
    let sum = 0;
    for (const r of rows)
      sum += (await get<{ remainingAmount: number }>(A, `/invoices/${r.id}`))
        .remainingAmount;
    return sum;
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

    await addClass(A, id.big, 'Toán 9A', 'monthly', 1_200_000);
    await addClass(A, id.small, 'Văn 9A', 'monthly', 100_000);
    await addClass(A, id.per, 'Lý 9A', 'per_session', 100_000, {
      chargeUnexcused: false,
    });
    for (const [sid, name] of [
      [id.s1, 'Nợ Một'],
      [id.s2, 'Thừa Hai'],
      [id.s3, 'Thừa Ba'],
      [id.s4, 'Đủ Bốn'],
      [id.sP, 'Sửa Điểm'],
    ] as const)
      await addStudent(A, sid, name);
    for (const sid of [id.s1, id.s2, id.s4]) await enroll(A, id.big, sid);
    await enroll(A, id.small, id.s3);
    await enroll(A, id.per, id.sP);
    // Lý 9A: 3 buổi tháng 12 (buổi 3 vắng không phép, lớp không tính), 1 buổi tháng 1, 1 buổi tháng 2.
    for (const [i, d] of ['2026-12-03', '2026-12-10', '2026-12-17'].entries())
      await addSession(id.per, sessP[i]!, d);
    await attend(sessP[0]!, id.sP, 'present');
    await attend(sessP[1]!, id.sP, 'present');
    await attend(sessP[2]!, id.sP, 'unexcused');
    const [sJan, sFeb] = [randomUUID(), randomUUID()];
    await addSession(id.per, sJan, '2027-01-07');
    await attend(sJan, id.sP, 'present');
    await addSession(id.per, sFeb, '2027-02-04');
    await attend(sFeb, id.sP, 'present');

    await addClass(B, randomUUID(), 'Hóa B', 'monthly', 500_000);
    await addStudent(B, id.bStu, 'Của B');
  }, 180_000);
  afterAll(async () => {
    await pool?.end();
    await t?.stop();
  });

  it('kỳ 12/2026: bản nháp không có dòng chuyển kỳ khi chưa có nợ; sau phát hành thu: nợ 200.000, trả thừa 50.000 và 300.000', async () => {
    expect(await job.run(CLOSE_DEC)).toBe(5);
    for (const sid of [id.s1, id.s2, id.s3, id.s4, id.sP]) {
      const lines = await linesOf((await invoiceOf(sid, '2026-12-01')).id);
      expect(lines.map((l) => l.kind)).not.toContain('carry_over');
    }
    expect(Number((await invoiceOf(id.sP, '2026-12-01')).total_amount)).toBe(
      200_000,
    );
    await issueDrafts('2026-12-01');
    const dec = (sid: string) => invoiceOf(sid, '2026-12-01');
    expect((await pay((await dec(id.s1)).id, 1_000_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.s2)).id, 1_250_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.s3)).id, 400_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.s4)).id, 1_200_000)).statusCode).toBe(201);
    expect((await pay((await dec(id.sP)).id, 200_000)).statusCode).toBe(201);
    // Giáo viên sửa điểm danh buổi 17/12: vắng không phép → có mặt, sau khi hóa đơn đã phát hành.
    await q(
      `update attendance set status = 'present' where session_id = $1 and student_id = $2`,
      [sessP[2], id.sP],
    );
  });

  let janS1: string;
  it('AC-1/AC-2/AC-4 (US-7.6 AC1–AC4, US-3.3 AC4): kỳ 01/2027 có dòng Nợ kỳ trước, trừ trả thừa, điều chỉnh kỳ trước, tổng âm → 0 đ', async () => {
    expect(await job.run(CLOSE_JAN)).toBe(5);
    const row = (sid: string) => invoiceOf(sid, '2027-01-01');

    // AC1: nợ 200.000 + phát sinh 1.200.000 → dòng nợ 200.000 và tổng 1.400.000.
    const s1 = await row(id.s1);
    janS1 = s1.id;
    expect(Number(s1.total_amount)).toBe(1_400_000);
    expect(
      (await linesOf(s1.id)).map((l) => [l.kind, l.description, l.amount]),
    ).toEqual([
      ['monthly', 'Học phí tháng', 1_200_000],
      ['carry_over', 'Nợ kỳ trước', 200_000],
    ]);
    // Hóa đơn cũ không đổi tiền, nhưng nợ đã chuyển: còn nợ 0, ghi `carried_amount`; sổ: nợ + đối ứng, số dư 0.
    const oldS1 = await invoiceOf(id.s1, '2026-12-01');
    expect(Number(oldS1.total_amount)).toBe(1_200_000);
    expect(Number(oldS1.carried_amount)).toBe(200_000);
    expect(
      (await get<{ remainingAmount: number }>(A, `/invoices/${oldS1.id}`))
        .remainingAmount,
    ).toBe(0);
    expect(
      (await ledgerOf(id.s1)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['unpaid_carried', 200_000, 0],
      ['applied_to_invoice', 0, 200_000],
    ]);

    // AC2: trả thừa 50.000 → dòng trừ 50.000, tổng 1.150.000.
    const s2 = await row(id.s2);
    expect(Number(s2.total_amount)).toBe(1_150_000);
    expect(
      (await linesOf(s2.id)).find((l) => l.kind === 'carry_over')?.amount,
    ).toBe(-50_000);
    expect(
      (await ledgerOf(id.s2)).map((l) => [l.kind, l.debit, l.credit]),
    ).toEqual([
      ['overpayment', 0, 50_000],
      ['applied_to_invoice', 50_000, 0],
    ]);

    // AC4: trả thừa 300.000 > phát sinh 100.000 → hóa đơn 0 đ (vẫn nháp), 200.000 ở lại sổ để chuyển tiếp.
    const s3 = await row(id.s3);
    expect(Number(s3.total_amount)).toBe(0);
    expect(s3.status).toBe('draft');
    expect(
      (await linesOf(s3.id)).find((l) => l.kind === 'carry_over')?.amount,
    ).toBe(-300_000);
    const led3 = await get<{ balanceAmount: number; creditAmount: number }>(
      A,
      `/students/${id.s3}/ledger`,
    );
    expect(led3).toMatchObject({
      balanceAmount: -200_000,
      creditAmount: 200_000,
    });

    // Đã thu đủ: không có dòng chuyển kỳ.
    expect((await linesOf((await row(id.s4)).id)).map((l) => l.kind)).toEqual([
      'monthly',
    ]);

    // AC2 (US-3.3 AC4): điểm danh sửa sau phát hành → dòng điều chỉnh +100.000 ghi rõ buổi; hóa đơn cũ không đổi.
    const sp = await row(id.sP);
    expect(Number(sp.total_amount)).toBe(200_000);
    const adj = (await linesOf(sp.id)).filter(
      (l) => l.kind === 'prev_adjustment',
    );
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({
      amount: 100_000,
      session_id: sessP[2],
      description:
        'Điều chỉnh kỳ trước: buổi 2026-12-17 (Lý 9A) tính thêm 100.000 đ',
    });
    const oldSp = await invoiceOf(id.sP, '2026-12-01');
    expect(Number(oldSp.total_amount)).toBe(200_000);
    expect((await linesOf(oldSp.id)).map((l) => l.kind)).not.toContain(
      'prev_adjustment',
    );
  });

  it('AC-3: chạy job lần hai không nhân đôi dòng chuyển kỳ, bút toán sổ hay nợ chuyển', async () => {
    const snap = async () => ({
      lines: await q(
        `select count(*)::int n from invoice_lines where tenant_id = $1`,
        [A.tenantId],
      ),
      ledger: await q(
        `select count(*)::int n from student_ledger where tenant_id = $1`,
        [A.tenantId],
      ),
      carried: await q(
        `select coalesce(sum(carried_amount), 0)::int n from invoices where tenant_id = $1`,
        [A.tenantId],
      ),
    });
    const before = await snap();
    expect(await job.run(CLOSE_JAN)).toBe(0);
    const [a, b] = await Promise.all([job.run(CLOSE_JAN), job.run(CLOSE_JAN)]);
    expect(a + b).toBe(0);
    expect(await snap()).toEqual(before);
  });

  it('ràng buộc DB: carried_amount phải khớp sổ unpaid_carried; unpaid_carried chỉ cho hóa đơn đã phát hành đúng học viên', async () => {
    const oldS1 = await invoiceOf(id.s1, '2026-12-01');
    await expect(
      q(
        `update invoices set carried_amount = carried_amount + 1000 where id = $1`,
        [oldS1.id],
      ),
    ).rejects.toThrow(/INVOICE_CARRIED_MISMATCH/);
    await expect(
      q(
        `insert into student_ledger (id, tenant_id, student_id, invoice_id, kind, debit, description)
         values ($1, $2, $3, $4, 'unpaid_carried', 1000, 'bịa')`,
        [randomUUID(), A.tenantId, id.s1, janS1], // hóa đơn nháp
      ),
    ).rejects.toThrow(/LEDGER_INVALID/);
    await expect(
      q(
        `insert into student_ledger (id, tenant_id, student_id, invoice_id, kind, debit, description)
         values ($1, $2, $3, $4, 'unpaid_carried', 1000, 'sai học viên')`,
        [randomUUID(), A.tenantId, id.s2, oldS1.id],
      ),
    ).rejects.toThrow(/LEDGER_INVALID/);
    await expect(
      q(`update invoices set carried_amount = total_amount + 1 where id = $1`, [
        oldS1.id,
      ]),
    ).rejects.toThrow(/invoices_carried_amount_check/);
  });

  it('công nợ: nợ đã chuyển chỉ tính ở hóa đơn kỳ sau (không đếm hai lần), Σ /receivables = Σ remainingAmount các hóa đơn còn nợ', async () => {
    await issueDrafts('2027-01-01');
    // Hóa đơn 0 đ của s3 giữ nguyên nháp (US-1.3 AC3): không phải công nợ.
    const r = await get<Receivables>(A, '/receivables');
    const byName = Object.fromEntries(r.items.map((i) => [i.studentName, i]));
    expect(byName['Nợ Một']).toMatchObject({
      outstandingAmount: 1_400_000,
      openInvoiceCount: 1,
      agingBucket: '0-30',
      classNames: ['Toán 9A'],
    });
    expect(byName['Đủ Bốn']?.outstandingAmount).toBe(1_200_000);
    expect(byName['Sửa Điểm']?.outstandingAmount).toBe(200_000);
    expect(byName['Thừa Hai']?.outstandingAmount).toBe(1_150_000);
    expect(byName['Thừa Ba']).toBeUndefined();
    expect(r.summary.totalAmount).toBe(
      1_400_000 + 1_200_000 + 200_000 + 1_150_000,
    );
    expect(r.items.map((i) => i.outstandingAmount)).toEqual(
      [...r.items.map((i) => i.outstandingAmount)].sort((a, b) => b - a),
    );
    expect(await sumRemaining()).toBe(r.summary.totalAmount);
  });

  it('công nợ: tuổi nợ từ hạn hóa đơn cũ nhất, nhóm 0–30/31–60/>60, lọc, sắp xếp, phân trang', async () => {
    const today = localDate(new Date(), 'Asia/Ho_Chi_Minh');
    const shift = (days: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
    const mkOld = async (
      name: string,
      ageDays: number,
      total: number,
      year: number,
      classId?: string,
    ) => {
      const sid = randomUUID();
      await addStudent(A, sid, name);
      if (classId) await enroll(A, classId, sid);
      for (const [k, due] of [
        [0, shift(ageDays)],
        [1, shift(ageDays - 20)],
      ] as const) {
        const period = randomUUID();
        const inv = randomUUID();
        await q(
          `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $4, $5)`,
          [period, A.tenantId, `${year + k}-01-01`, due, due],
        );
        await q(
          `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
          [inv, A.tenantId, period, sid, total],
        );
        const code = generateInvoiceCode();
        await q(
          `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
             payout = '{"bankBin":"970436","accountNo":"1","accountName":"A"}'::jsonb, issued_at = '2026-01-01T00:00:00Z' where id = $1`,
          [inv, code, code.replace('-', ' ')],
        );
      }
      return sid;
    };
    // Hai hóa đơn mỗi học viên: tuổi nợ lấy theo hóa đơn CŨ nhất (hạn = ageDays trước).
    await mkOld('Khoa Mới', 5, 100_000, 2031);
    await mkOld('Lan Vừa', 45, 300_000, 2033, id.big);
    await mkOld('Minh Lâu', 90, 500_000, 2035);
    const all = await get<Receivables>(A, '/receivables?pageSize=100');
    const row = (n: string) => all.items.find((i) => i.studentName === n);
    expect(row('Khoa Mới')).toMatchObject({
      agingBucket: '0-30',
      overdueDays: 5,
      outstandingAmount: 200_000,
      openInvoiceCount: 2,
    });
    expect(row('Lan Vừa')).toMatchObject({
      agingBucket: '31-60',
      overdueDays: 45,
      oldestDueDate: shift(45),
    });
    expect(row('Minh Lâu')).toMatchObject({
      agingBucket: 'over-60',
      overdueDays: 90,
    });
    expect(all.summary.buckets.map((b) => b.agingBucket)).toEqual([
      '0-30',
      '31-60',
      'over-60',
    ]);
    const bucket = (n: string) =>
      all.summary.buckets.find((b) => b.agingBucket === n);
    expect(bucket('31-60')).toMatchObject({
      studentCount: 1,
      totalAmount: 600_000,
    });
    expect(bucket('over-60')).toMatchObject({
      studentCount: 1,
      totalAmount: 1_000_000,
    });
    expect(all.summary.totalAmount).toBe(
      bucket('0-30')!.totalAmount + 600_000 + 1_000_000,
    );
    expect(all.summary.totalAmount).toBe(await sumRemaining());

    const over = await get<Receivables>(A, '/receivables?agingBucket=over-60');
    expect(over.items.map((i) => i.studentName)).toEqual(['Minh Lâu']);
    expect(over.total).toBe(1);
    expect(over.summary.buckets).toEqual(all.summary.buckets); // summary không lọc theo agingBucket
    const byClass = await get<Receivables>(
      A,
      `/receivables?classId=${id.small}`,
    );
    expect(byClass.items).toEqual([]);
    const byBig = await get<Receivables>(A, `/receivables?classId=${id.big}`);
    expect(byBig.items.map((i) => i.studentName).sort()).toEqual(
      ['Thừa Hai', 'Lan Vừa', 'Nợ Một', 'Đủ Bốn'].sort(),
    );
    expect(byBig.summary.totalAmount).toBe(
      1_150_000 + 600_000 + 1_400_000 + 1_200_000,
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
    expect(old.items[0]?.studentName).toBe('Minh Lâu');
    const p1 = await get<Receivables>(A, '/receivables?pageSize=2&page=2');
    expect(p1).toMatchObject({ page: 2, pageSize: 2, total: all.items.length });
    expect(p1.items).toHaveLength(2);
    expect(
      (await call(A, 'GET', '/receivables?agingBucket=61%2B')).statusCode,
    ).toBe(422);
  });

  it('GET /receivables/{studentId}: lịch sử hóa đơn, thanh toán, số dư sổ; học viên hết nợ vẫn xem được', async () => {
    const h = await get<StudentReceivableHistory>(A, `/receivables/${id.s1}`);
    expect(h).toMatchObject({
      studentId: id.s1,
      studentName: 'Nợ Một',
      outstandingAmount: 1_400_000,
      ledgerBalanceAmount: 0,
      reminders: [],
    });
    expect(h.enrollments.map((e) => e.className)).toEqual(['Toán 9A']);
    expect(
      h.invoices.map((i) => [
        i.periodMonth,
        i.totalAmount,
        i.paidAmount,
        i.remainingAmount,
      ]),
    ).toEqual([
      ['2027-01-01', 1_400_000, 0, 1_400_000],
      ['2026-12-01', 1_200_000, 1_000_000, 0],
    ]);
    expect(h.payments).toHaveLength(1);
    expect(h.payments[0]).toMatchObject({
      amount: 1_000_000,
      invoiceCode: expect.stringMatching(/^TH-/),
    });
    const clean = await get<StudentReceivableHistory>(
      A,
      `/receivables/${id.s3}`,
    );
    expect(clean).toMatchObject({
      outstandingAmount: 0,
      ledgerBalanceAmount: -200_000,
    });
  });

  it('GET /students/{id}/ledger: số dư, các bút toán mới nhất trước, phân trang; học viên chưa có sổ → 0', async () => {
    const l = await get<StudentLedger>(A, `/students/${id.s1}/ledger`);
    expect(l).toMatchObject({
      studentId: id.s1,
      studentName: 'Nợ Một',
      balanceAmount: 0,
      debtAmount: 0,
      creditAmount: 0,
    });
    expect(l.entries).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(l.entries.items.map((e) => e.kind)).toEqual([
      'applied_to_invoice',
      'unpaid_carried',
    ]);
    expect(l.entries.items[1]).toMatchObject({
      debitAmount: 200_000,
      creditAmount: 0,
    });
    const page = await get<StudentLedger>(
      A,
      `/students/${id.s3}/ledger?pageSize=1&page=2`,
    );
    expect(page.entries.items).toHaveLength(1);
    expect(page.entries.total).toBe(2);
    const empty = await get<StudentLedger>(A, `/students/${id.s4}/ledger`);
    expect(empty).toMatchObject({
      balanceAmount: 0,
      entries: { items: [], total: 0 },
    });
  });

  it('kỳ 02/2027: nợ đã chuyển không chuyển lần nữa (1.400.000, không 1.600.000), chênh lệch điểm danh không điều chỉnh lại, phần dư trả thừa tiếp tục chuyển', async () => {
    expect(await job.run(CLOSE_FEB)).toBeGreaterThanOrEqual(5);
    const feb = (sid: string) => invoiceOf(sid, '2027-02-01');
    const s1 = await feb(id.s1);
    expect(Number(s1.total_amount)).toBe(2_600_000);
    expect(
      (await linesOf(s1.id)).find((l) => l.kind === 'carry_over')?.amount,
    ).toBe(1_400_000);
    expect(Number((await invoiceOf(id.s1, '2026-12-01')).carried_amount)).toBe(
      200_000,
    );
    expect(Number((await invoiceOf(id.s1, '2027-01-01')).carried_amount)).toBe(
      1_400_000,
    );
    expect(
      (await get<StudentLedger>(A, `/students/${id.s1}/ledger`)).balanceAmount,
    ).toBe(0);
    // sP: nợ 200.000 của kỳ 01 chuyển sang, không còn dòng điều chỉnh (đã điều chỉnh ở kỳ 01).
    const sp = await linesOf((await feb(id.sP)).id);
    expect(sp.map((l) => l.kind)).toEqual(['session', 'carry_over']);
    // s3: dư 200.000, phát sinh 100.000 → 0 đ, còn 100.000.
    const s3 = await feb(id.s3);
    expect(Number(s3.total_amount)).toBe(0);
    expect(
      (await get<StudentLedger>(A, `/students/${id.s3}/ledger`)).balanceAmount,
    ).toBe(-100_000);
    await issueDrafts('2027-02-01');
    expect(await sumRemaining()).toBe(
      (await get<Receivables>(A, '/receivables')).summary.totalAmount,
    );
  });

  it('hóa đơn đã chuyển nợ: không ghi thanh toán, không hủy (409); hủy thanh toán trước đó vẫn cho và nợ quay lại đúng phần chưa chuyển', async () => {
    const jan = await invoiceOf(id.s1, '2027-01-01');
    const p = await pay(jan.id, 100_000);
    expect(p.statusCode, p.body).toBe(409);
    expect(p.json().code).toBe('INVOICE_NOT_PAYABLE');
    const v = await call(A, 'POST', `/invoices/${jan.id}/void`, {
      reason: 'nhầm',
    });
    expect(v.statusCode).toBe(409);
    // Hóa đơn nhận khoản chuyển kỳ cũng không hủy được (hủy sẽ làm mất nợ).
    const feb = await invoiceOf(id.s1, '2027-02-01');
    expect(
      (await call(A, 'POST', `/invoices/${feb.id}/void`, { reason: 'nhầm' }))
        .statusCode,
    ).toBe(409);
    const dec = await invoiceOf(id.s1, '2026-12-01');
    const pays = await get<{ items: { id: string }[] }>(
      A,
      `/invoices/${dec.id}/payments`,
    );
    const vp = await call(A, 'POST', `/payments/${pays.items[0]!.id}/void`, {
      reason: 'ghi nhầm',
    });
    expect(vp.statusCode, vp.body).toBe(200);
    // Thu 1.000.000 bị hủy: nợ thật 1.200.000, đã chuyển 200.000 → còn 1.000.000 ở hóa đơn cũ, không đếm trùng phần đã chuyển.
    expect(vp.json()).toMatchObject({
      status: 'issued',
      paidAmount: 0,
      remainingAmount: 1_000_000,
    });
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

    // Cô lập tenant: B gọi học viên của A → 404; id lạ → 404; B không có công nợ nào.
    expect((await call(B, 'GET', `/students/${id.s1}/ledger`)).statusCode).toBe(
      404,
    );
    expect((await call(B, 'GET', `/receivables/${id.s1}`)).statusCode).toBe(
      404,
    );
    expect(
      (await call(B, 'GET', `/students/${randomUUID()}/ledger`)).statusCode,
    ).toBe(404);
    const rb = await get<Receivables>(B, '/receivables');
    expect(rb).toMatchObject({
      items: [],
      total: 0,
      summary: { totalAmount: 0 },
    });
    // classId của tenant A trong tenant B: không lộ học viên A.
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
});
