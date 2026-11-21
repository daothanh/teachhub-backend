import { randomUUID } from 'node:crypto';
import type {
  MonthOverview,
  Revenue12m,
  RevenueByClass,
  RevenueEntries,
} from '../libs/modules/reports/http/reports.schemas.js';
import type { Receivables } from '../libs/modules/billing/http/receivables.schemas.js';
import { generateInvoiceCode } from '../libs/modules/billing/domain/invoice-issue.js';
import { localDate } from '../libs/modules/schedule/domain/zoned-time.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// Mã lớp cố định để thứ tự làm tròn phần dư (theo khóa) xác định.
const C1 = '019b2c10-0001-7a10-8a01-0000000000a1'; // Toán 9A
const C2 = '019b2c10-0001-7a10-8a01-0000000000a2'; // Lý 9B
const C3 = '019b2c10-0001-7a10-8a01-0000000000a3'; // Cũ (lưu trữ)

// S7 reports (US-8.1, US-8.2, US-7.4 AC3): số liệu T12 sau chuỗi phát hành/thu/hủy; tenant khác không thấy; chỉ chủ tenant.
describe('reports: báo cáo doanh thu T12', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;
  let teacher: { token: string };
  let parent: { token: string };
  const cur = localDate(new Date(), 'Asia/Ho_Chi_Minh');
  const curMonth = cur.slice(0, 7);

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
  const get = async <T>(who: { token: string }, url: string): Promise<T> => {
    const r = await call(who, 'GET', url);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as T;
  };
  const overview = (who: Who, m: string) =>
    get<MonthOverview>(who, `/reports/month-overview?month=${m}`);
  const byClass = (who: Who, m: string) =>
    get<RevenueByClass>(who, `/reports/revenue-by-class?month=${m}`);

  const periods = new Map<string, string>();
  const period = async (month: string) => {
    if (!periods.has(month)) {
      const id = randomUUID();
      await q(
        `insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
         values ($1, $2, $3, $3, ($3::date + 9))`,
        [id, A.tenantId, `${month}-01`],
      );
      periods.set(month, id);
    }
    return periods.get(month)!;
  };
  const student = async (name: string, status = 'active') => {
    const id = randomUUID();
    await q(
      `insert into students (id, tenant_id, full_name, status) values ($1, $2, $3, $4)`,
      [id, A.tenantId, name, status],
    );
    return id;
  };
  type L = [kind: string, amount: number, className: string | null];
  const invoice = async (
    month: string,
    studentId: string,
    lines: L[],
    status: 'draft' | 'issued' | 'void' = 'issued',
  ) => {
    const id = randomUUID();
    const total = lines.reduce((n, l) => n + l[1], 0);
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [id, A.tenantId, await period(month), studentId, total],
    );
    let pos = 0;
    for (const [kind, amount, className] of lines)
      await q(
        `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount, class_name)
         values ($1, $2, $3, $4, $5, 'dòng', $6, $7)`,
        [randomUUID(), A.tenantId, id, ++pos, kind, amount, className],
      );
    if (status !== 'draft') {
      const code = generateInvoiceCode();
      await q(
        `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
           payout = '{"bankBin":"970436","accountNo":"0011001234567","accountName":"NGUYEN VAN A"}'::jsonb,
           issued_at = '2026-01-01T00:00:00Z' where id = $1`,
        [id, code, code.replace('-', ' ')],
      );
    }
    if (status === 'void')
      await q(
        `update invoices set status = 'void', voided_at = now(), void_reason = 'nhầm' where id = $1`,
        [id],
      );
    return id;
  };
  const pay = async (invoiceId: string, amount: number, paidOn: string) => {
    const r = await call(A, 'POST', `/invoices/${invoiceId}/payments`, {
      amount,
      method: 'bank_transfer',
      paidOn,
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { payment: { id: string } }).payment.id;
  };
  let i1 = '';
  let i2 = '';
  let i3 = '';

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
    teacher = {
      token: await t.tokenFor(
        await seedMember(t.worker, A.tenantId, 'teacher'),
      ),
    };
    const pid = randomUUID();
    await q(`insert into users (id, email) values ($1, $2)`, [
      pid,
      `${pid}@example.com`,
    ]);
    parent = { token: await t.tokenFor(pid) };

    for (const [id, name, status] of [
      [C1, 'Toán 9A', 'active'],
      [C2, 'Lý 9B', 'active'],
      [C3, 'Cũ', 'archived'],
    ])
      await q(
        `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, fee_type, fee_amount, status)
         values ($1, $2, $3, $4, 'Toán', 9, 'online', '2026-01-01', 'monthly', 1000000, $5)`,
        [id, A.tenantId, A.branchId, name, status],
      );
    const [s1, s2, s3, s4, s5] = [
      await student('S1'),
      await student('S2'),
      await student('S3'),
      await student('S4'),
      await student('S5'),
    ];
    await student('S6', 'left');
    // Hóa đơn hai lớp, thu một phần.
    i1 = await invoice('2026-10', s1, [
      ['monthly', 1_000_000, 'Toán 9A'],
      ['monthly', 500_000, 'Lý 9B'],
    ]);
    // Có nợ kỳ trước (carry_over) → "Khác".
    i2 = await invoice('2026-10', s2, [
      ['monthly', 1_000_000, 'Toán 9A'],
      ['carry_over', 200_000, null],
    ]);
    // Ba lớp bằng nhau: làm tròn phần dư; lớp thứ ba đã lưu trữ.
    i3 = await invoice('2026-09', s3, [
      ['monthly', 10_000, 'Toán 9A'],
      ['monthly', 10_000, 'Lý 9B'],
      ['monthly', 10_000, 'Cũ'],
    ]);
    await invoice('2026-10', s4, [['monthly', 5_000_000, 'Toán 9A']], 'draft');
    await invoice('2026-10', s5, [['monthly', 700_000, 'Toán 9A']], 'void');

    await pay(i1, 600_000, '2026-10-20');
    await pay(i2, 1_200_000, '2026-10-22');
    await pay(i3, 10_000, '2026-09-10');
    const voided = await pay(i3, 20_000, '2026-09-12');
    const v = await call(A, 'POST', `/payments/${voided}/void`, {
      reason: 'nhập nhầm',
    });
    expect(v.statusCode, v.body).toBe(200);

    // Chuyên cần: lớp 1 có 4 lượt (2 có mặt/muộn), lớp 2 có buổi đã dạy chưa điểm danh, buổi dự kiến không tính.
    const sess = async (cid: string, status: string) => {
      const id = randomUUID();
      await q(
        `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
         values ($1, $2, $3, '2026-10-05', '2026-10-05T11:00:00Z', '2026-10-05T12:00:00Z', $4)`,
        [id, A.tenantId, cid, status],
      );
      return id;
    };
    const taught = await sess(C1, 'taught');
    for (const [s, st] of [
      [s1, 'present'],
      [s2, 'late'],
      [s3, 'unexcused'],
      [s4, 'excused'],
    ])
      await q(
        `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at)
         values ($1, $2, $3, $4, $5, now())`,
        [randomUUID(), A.tenantId, taught, s, st],
      );
    await sess(C2, 'taught');
    await sess(C3, 'planned');
  }, 180_000);
  afterAll(() => t?.stop());

  it('month-overview: phải thu, đã thu, công nợ, học viên (US-8.1 AC1)', async () => {
    const debt = await get<Receivables>(A, '/receivables');
    expect(await overview(A, '2026-10')).toEqual({
      month: '2026-10',
      billedAmount: 2_700_000, // không tính nháp và hóa đơn hủy
      collectedAmount: 1_800_000,
      outstandingAmount: debt.summary.totalAmount,
      activeStudentCount: 5,
      hasData: true,
    });
    // I1 còn 900.000, I3 còn 20.000 (khoản 20.000 đã hủy), I2 đã đủ.
    expect(debt.summary.totalAmount).toBe(920_000);
    expect(await overview(A, '2026-09')).toMatchObject({
      billedAmount: 30_000,
      collectedAmount: 10_000, // dòng đảo mang ngày thu gốc: khoản 20.000 đã hủy không còn trong tháng
    });
    expect(await overview(A, '2031-01')).toMatchObject({
      billedAmount: 0,
      collectedAmount: 0,
      hasData: false,
    });
  });

  it('hủy thanh toán là sửa sai: dòng đảo trừ khỏi tháng của khoản thu gốc, tháng hiện tại không đổi (US-7.4 AC3)', async () => {
    expect(await overview(A, curMonth)).toMatchObject({
      collectedAmount: 0,
      hasData: false,
    });
    const def = await get<MonthOverview>(A, '/reports/month-overview');
    expect(def.month).toBe(curMonth);
  });

  it('payments: từng bút toán, mới nhất trước, totalAmount = đã thu (US-8.1 AC2)', async () => {
    const all = await get<RevenueEntries>(A, '/reports/payments?month=2026-10');
    expect(all).toMatchObject({ total: 2, page: 1, totalAmount: 1_800_000 });
    expect(all.items.map((i) => [i.invoiceId, i.entryDate, i.amount])).toEqual([
      [i2, '2026-10-22', 1_200_000],
      [i1, '2026-10-20', 600_000],
    ]);
    expect(all.items[0]).toMatchObject({
      kind: 'payment',
      studentName: 'S2',
      method: 'bank_transfer',
    });
    expect(all.items[0]!.invoiceCode).toMatch(/^TH-/);
    const p2 = await get<RevenueEntries>(
      A,
      '/reports/payments?month=2026-10&page=2&pageSize=1',
    );
    expect(p2.items.map((i) => i.invoiceId)).toEqual([i1]);
    expect(p2).toMatchObject({ total: 2, totalAmount: 1_800_000 });
    // Tháng 09: hai khoản thu và dòng đảo của khoản 20.000 (mới ghi nhất trước), tổng = 10.000.
    const sep = await get<RevenueEntries>(A, '/reports/payments?month=2026-09');
    expect(sep).toMatchObject({ total: 3, totalAmount: 10_000 });
    expect(sep.items.map((i) => [i.kind, i.amount, i.entryDate])).toEqual([
      ['reversal', -20_000, '2026-09-12'],
      ['payment', 20_000, '2026-09-12'],
      ['payment', 10_000, '2026-09-10'],
    ]);
    expect(sep.items.every((i) => i.invoiceId === i3)).toBe(true);
  });

  it('revenue-by-class: chia theo tỷ lệ, nợ kỳ trước vào "Khác", tổng = đã thu (US-8.2 AC3)', async () => {
    const r = await byClass(A, '2026-10');
    // I1: 600.000 chia 1.000.000:500.000 → 400.000 / 200.000; I2: 1.200.000 chia 1.000.000:200.000 → 1.000.000 / Khác 200.000
    expect(r.items).toEqual([
      {
        classId: C1,
        className: 'Toán 9A',
        archived: false,
        collectedAmount: 1_400_000,
        attendancePercent: 50,
      },
      {
        classId: C2,
        className: 'Lý 9B',
        archived: false,
        collectedAmount: 200_000,
        attendancePercent: null, // có buổi đã dạy nhưng chưa điểm danh
      },
      {
        classId: null,
        className: null,
        archived: false,
        collectedAmount: 200_000,
        attendancePercent: null,
      },
    ]);
    expect(r.collectedAmount).toBe(1_800_000);
    expect((await overview(A, '2026-10')).collectedAmount).toBe(
      r.collectedAmount,
    );
  });

  it('revenue-by-class: phần dư lớn nhất theo từng bút toán, dòng đảo đảo đúng từng đồng; lớp lưu trữ vẫn có dòng (US-8.2 AC2)', async () => {
    const r = await byClass(A, '2026-09');
    // 10.000 → 3.334/3.333/3.333; 20.000 → 6.667/6.667/6.666 rồi đảo hết: còn đúng khoản 10.000 (hòa phần dư: mã lớp nhỏ trước)
    expect(
      r.items.map((i) => [i.classId, i.collectedAmount, i.archived]),
    ).toEqual([
      [C1, 3_334, false],
      [C3, 3_333, true], // cùng số tiền: xếp theo tên (Cũ trước Lý)
      [C2, 3_333, false],
    ]);
    expect(r.collectedAmount).toBe(10_000);
    expect((await overview(A, '2026-09')).collectedAmount).toBe(10_000);
    expect((await byClass(A, curMonth)).items).toEqual([]);
  });

  it('revenue-12m: 12 tháng liên tiếp, cũ nhất trước, mỗi cột = đã thu của tháng', async () => {
    const r = await get<Revenue12m>(A, '/reports/revenue-12m?month=2026-10');
    expect(r.months).toHaveLength(12);
    expect(r.months[0]).toEqual({ month: '2025-11', collectedAmount: 0 });
    expect(r.months[10]).toEqual({ month: '2026-09', collectedAmount: 10_000 });
    expect(r.months[11]).toEqual({
      month: '2026-10',
      collectedAmount: 1_800_000,
    });
    const now = await get<Revenue12m>(A, '/reports/revenue-12m');
    expect(now.months[11]).toEqual({
      month: curMonth,
      collectedAmount: 0,
    });
    expect(now.months.map((m) => m.month)).toEqual(
      now.months.map((m) => m.month).sort(),
    );
    // Cột khớp tổng quan của chính tháng đó.
    for (const m of now.months)
      expect((await overview(A, m.month)).collectedAmount).toBe(
        m.collectedAmount,
      );
  });

  it('chỉ chủ tenant: giáo viên và phụ huynh 403; tháng sai dạng 422', async () => {
    for (const who of [teacher, parent])
      for (const url of [
        '/reports/month-overview',
        '/reports/payments',
        '/reports/revenue-by-class',
        '/reports/revenue-12m',
      ])
        expect((await call(who, 'GET', url)).statusCode, url).toBe(403);
    for (const m of ['2026-13', '2026-1', 'abc'])
      expect(
        (await call(A, 'GET', `/reports/month-overview?month=${m}`)).statusCode,
      ).toBe(422);
  });

  it('chéo tenant: B không thấy số liệu của A', async () => {
    expect(await overview(B, '2026-10')).toEqual({
      month: '2026-10',
      billedAmount: 0,
      collectedAmount: 0,
      outstandingAmount: 0,
      activeStudentCount: 0,
      hasData: false,
    });
    expect(
      await get<RevenueEntries>(B, '/reports/payments?month=2026-10'),
    ).toMatchObject({
      items: [],
      total: 0,
      totalAmount: 0,
    });
    expect(await byClass(B, '2026-10')).toMatchObject({
      items: [],
      collectedAmount: 0,
    });
    expect(
      (
        await get<Revenue12m>(B, '/reports/revenue-12m?month=2026-10')
      ).months.every((m) => m.collectedAmount === 0),
    ).toBe(true);
    expect((await byClass(B, curMonth)).items).toEqual([]);
  });
});
