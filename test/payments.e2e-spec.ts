import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { generateInvoiceCode } from '../libs/modules/billing/domain/invoice-issue.js';
import { localDate } from '../libs/modules/schedule/domain/zoned-time.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };
type Res = {
  payment: Record<string, unknown> & { id: string };
  status: string;
  paidAmount: number;
  remainingAmount: number;
  overpaidAmount: number;
  dunningCancelled: boolean;
};

const TERMS = '2026-12-01';

// S6-BE-02: ghi/hủy thanh toán (US-7.4), sổ học viên + sổ doanh thu (US-9.5 AC1), biên nhận, test đối soát (DoD Mục 6.5).
describe('payments: ghi và hủy thanh toán', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;
  let teacherToken: string;
  let seq = 0;

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    token: string | null,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    key: string | null = method === 'POST' ? randomUUID() : null,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });
  const pay = (
    who: { token: string },
    invoiceId: string,
    body: object,
    key?: string | null,
  ) => call(who.token, 'POST', `/invoices/${invoiceId}/payments`, body, key);
  const voidPay = (
    who: { token: string },
    id: string,
    reason: string,
    key?: string | null,
  ) => call(who.token, 'POST', `/payments/${id}/void`, { reason }, key);
  const inv = async (id: string) =>
    (await q(`select * from invoices where id = $1`, [id]))[0];

  /** Học viên + kỳ riêng + hóa đơn; `status` mặc định đã phát hành. */
  const mkInvoice = async (
    who: SeededTenant,
    total = 1_200_000,
    status: 'draft' | 'issued' | 'void' = 'issued',
    studentId?: string,
    issuedAt = '2026-01-01T00:00:00Z',
  ) => {
    seq++;
    const stu = studentId ?? randomUUID();
    if (!studentId)
      await q(
        `insert into students (id, tenant_id, full_name) values ($1, $2, 'Lê Gia Bảo')`,
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
        `${2040 + Math.floor(seq / 12)}-${String((seq % 12) + 1).padStart(2, '0')}-01`,
      ],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [id, who.tenantId, period, stu, total],
    );
    if (status !== 'draft') {
      const code = generateInvoiceCode();
      await q(
        `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
           payout = '{"bankBin":"970436","accountNo":"0011001234567","accountName":"NGUYEN VAN A"}'::jsonb, issued_at = $4::timestamptz where id = $1`,
        [id, code, code.replace('-', ' '), issuedAt],
      );
    }
    if (status === 'void')
      await q(
        `update invoices set status = 'void', voided_at = now(), void_reason = 'nhầm' where id = $1`,
        [id],
      );
    return { id, studentId: stu };
  };
  /** Σ theo tenant: thanh toán còn hiệu lực, paid_amount hóa đơn, sổ doanh thu (US-9.5 AC1, DoD 6.5). */
  const reconcile = async (tenantId: string) => {
    const [r] = await q(
      `select
         (select coalesce(sum(amount), 0)::bigint from payments where tenant_id = $1 and voided_at is null) as payments,
         (select coalesce(sum(paid_amount), 0)::bigint from invoices where tenant_id = $1) as invoices,
         (select coalesce(sum(amount), 0)::bigint from revenue_ledger where tenant_id = $1) as revenue`,
      [tenantId],
    );
    return {
      payments: Number(r.payments),
      invoices: Number(r.invoices),
      revenue: Number(r.revenue),
    };
  };
  const studentBalance = async (invoiceId: string) =>
    Number(
      (
        await q(
          `select coalesce(sum(credit - debit), 0)::bigint as n from student_ledger where invoice_id = $1`,
          [invoiceId],
        )
      )[0].n,
    );

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (name: string): Promise<Who> => {
      const s = await seedTenant(t.worker);
      await q(`update users set display_name = $2 where id = $1`, [
        s.userId,
        name,
      ]);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk('Cô Lan'), await mk('Thầy Bình')];
    teacherToken = await t.tokenFor(
      await seedMember(t.worker, A.tenantId, 'teacher'),
    );
  }, 180_000);
  afterAll(() => t?.stop());

  describe('AC-2: ghi thanh toán', () => {
    it('thu một phần rồi thu nốt: trạng thái, paidAmount, remainingAmount, hai sổ, outbox, audit', async () => {
      const { id, studentId } = await mkInvoice(A, 1_200_000);
      const r1 = await pay(A, id, {
        amount: 500_000,
        method: 'bank_transfer',
        paidOn: '2026-10-05',
        note: '  CK sáng  ',
      });
      expect(r1.statusCode, r1.body).toBe(201);
      const b1 = r1.json() as Res;
      expect(b1).toMatchObject({
        status: 'partially_paid',
        paidAmount: 500_000,
        remainingAmount: 700_000,
        overpaidAmount: 0,
        dunningCancelled: false,
        payment: {
          invoiceId: id,
          amount: 500_000,
          method: 'bank_transfer',
          paidOn: '2026-10-05',
          note: 'CK sáng',
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
          recordedBy: { id: A.userId, name: 'Cô Lan' },
        },
      });
      expect(b1.payment.recordedAt).toMatch(/\+07:00$/);
      expect(await inv(id)).toMatchObject({
        status: 'partially_paid',
        paid_amount: '500000',
        total_amount: '1200000',
      });
      expect(
        await q(`select * from student_ledger where invoice_id = $1`, [id]),
      ).toHaveLength(0);
      expect(
        await q(
          `select kind, amount, entry_date::text, fiscal_year from revenue_ledger where payment_id = $1`,
          [b1.payment.id],
        ),
      ).toEqual([
        {
          kind: 'payment',
          amount: '500000',
          entry_date: '2026-10-05',
          fiscal_year: 2026,
        },
      ]);

      const r2 = await pay(A, id, { amount: 700_000, method: 'cash' });
      expect(r2.statusCode, r2.body).toBe(201);
      expect(r2.json()).toMatchObject({
        status: 'paid',
        paidAmount: 1_200_000,
        remainingAmount: 0,
        overpaidAmount: 0,
      });
      // paidOn mặc định = hôm nay theo múi giờ tenant.
      expect((r2.json() as Res).payment.paidOn).toBe(
        localDate(new Date(), 'Asia/Ho_Chi_Minh'),
      );
      const more = await pay(A, id, { amount: 1, method: 'cash' });
      expect(more.statusCode).toBe(409);
      expect(more.json().code).toBe('INVOICE_NOT_PAYABLE');

      // Outbox cùng giao dịch, payload không tên con.
      const ev = await q(
        `select payload from outbox_events where tenant_id = $1 and type = 'payment_recorded' and payload->>'invoiceId' = $2 order by created_at`,
        [A.tenantId, id],
      );
      expect(ev.map((e) => e.payload)).toEqual([
        {
          invoiceId: id,
          paymentId: b1.payment.id,
          studentId,
          amount: 500_000,
          paidOn: '2026-10-05',
          status: 'partially_paid',
          remainingAmount: 700_000,
        },
        expect.objectContaining({ status: 'paid', remainingAmount: 0 }),
      ]);
      expect(JSON.stringify(ev)).not.toMatch(/Lê Gia Bảo/);
      // Audit: người ghi, hóa đơn trước/sau.
      const audits = await q(
        `select entity, action, actor_user_id, before_data, after_data from audit_logs where tenant_id = $1 and entity_id = any($2) order by created_at`,
        [A.tenantId, [b1.payment.id, id]],
      );
      expect(audits.filter((a) => a.entity === 'payment')).toHaveLength(1);
      expect(audits.filter((a) => a.entity === 'invoice')).toHaveLength(2);
      expect(audits.every((a) => a.actor_user_id === A.userId)).toBe(true);
      expect(
        audits.find(
          (a) =>
            a.entity === 'invoice' && a.after_data.status === 'partially_paid',
        )?.before_data,
      ).toMatchObject({ status: 'issued', paidAmount: 0 });
    });

    it('trả thừa: hóa đơn paid, phần dư vào sổ học viên, revenue_ledger đúng số tiền thu', async () => {
      const { id, studentId } = await mkInvoice(A, 1_000_000);
      const r = await pay(A, id, { amount: 1_300_000, method: 'cash' });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({
        status: 'paid',
        paidAmount: 1_300_000,
        remainingAmount: 0,
        overpaidAmount: 300_000,
      });
      expect(
        await q(
          `select kind, debit::text, credit::text, student_id from student_ledger where invoice_id = $1`,
          [id],
        ),
      ).toEqual([
        {
          kind: 'overpayment',
          debit: '0',
          credit: '300000',
          student_id: studentId,
        },
      ]);
      const rev = await q(
        `select amount::text from revenue_ledger where payment_id = $1`,
        [(r.json() as Res).payment.id],
      );
      expect(rev).toEqual([{ amount: '1300000' }]);
    });

    it('hóa đơn draft, void, đã paid → 409 INVOICE_NOT_PAYABLE, không ghi gì', async () => {
      const draft = await mkInvoice(A, 100_000, 'draft');
      const voided = await mkInvoice(A, 100_000, 'void');
      const paid = await mkInvoice(A, 100_000);
      await pay(A, paid.id, { amount: 100_000, method: 'cash' });
      for (const id of [draft.id, voided.id, paid.id]) {
        const r = await pay(A, id, { amount: 1000, method: 'cash' });
        expect(r.statusCode, id).toBe(409);
        expect(r.json().code).toBe('INVOICE_NOT_PAYABLE');
      }
      expect(
        await q(`select 1 from payments where invoice_id = any($1)`, [
          [draft.id, voided.id],
        ]),
      ).toHaveLength(0);
    });

    it('kiểm tra đầu vào: Idempotency-Key bắt buộc, amount ≤ 0, method lạ, ngày sau hôm nay, ghi chú dài → 422; không ghi gì', async () => {
      const { id } = await mkInvoice(A);
      const bad: [object, string | null | undefined][] = [
        [{ amount: 1000, method: 'cash' }, null],
        [{ amount: 0, method: 'cash' }, undefined],
        [{ amount: -5, method: 'cash' }, undefined],
        [{ amount: 1.5, method: 'cash' }, undefined],
        [{ amount: 1000, method: 'card' }, undefined],
        [{ amount: 1000, method: 'cash', paidOn: '2999-01-01' }, undefined],
        [{ amount: 1000, method: 'cash', note: 'x'.repeat(301) }, undefined],
      ];
      for (const [body, key] of bad) {
        const r = await pay(A, id, body, key);
        expect(r.statusCode, JSON.stringify(body)).toBe(422);
        expect(r.json().code).toBe('VALIDATION_FAILED');
      }
      expect(
        await q(`select 1 from payments where invoice_id = $1`, [id]),
      ).toHaveLength(0);
      expect((await inv(id)).status).toBe('issued');
    });

    it('hóa đơn đã thu một phần rồi bị hủy hết thanh toán thì hủy hóa đơn được; hóa đơn còn thanh toán hiệu lực thì 409', async () => {
      const { id } = await mkInvoice(A, 500_000);
      const p = (
        await pay(A, id, { amount: 100_000, method: 'cash' })
      ).json() as Res;
      const blocked = await call(A.token, 'POST', `/invoices/${id}/void`, {
        reason: 'x',
      });
      expect(blocked.statusCode).toBe(409);
      await voidPay(A, p.payment.id, 'Ghi nhầm');
      const ok = await call(A.token, 'POST', `/invoices/${id}/void`, {
        reason: 'x',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await inv(id)).status).toBe('void');
    });
  });

  describe('AC-3: hủy thanh toán', () => {
    it('hủy lần thu cuối: về partially_paid, bút toán đảo ở sổ doanh thu, audit; hủy hết → issued', async () => {
      const { id } = await mkInvoice(A, 1_200_000);
      const p1 = (
        await pay(A, id, {
          amount: 500_000,
          method: 'cash',
          paidOn: '2026-10-05',
        })
      ).json() as Res;
      const p2 = (
        await pay(A, id, { amount: 700_000, method: 'bank_transfer' })
      ).json() as Res;
      expect((await inv(id)).status).toBe('paid');

      const v = await voidPay(A, p2.payment.id, '  Ghi nhầm hóa đơn  ');
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json()).toMatchObject({
        status: 'partially_paid',
        paidAmount: 500_000,
        remainingAmount: 700_000,
        overpaidAmount: 0,
        dunningCancelled: false,
        payment: {
          id: p2.payment.id,
          voidReason: 'Ghi nhầm hóa đơn',
          voidedBy: { id: A.userId, name: 'Cô Lan' },
        },
      });
      expect((v.json() as Res).payment.voidedAt).toMatch(/\+07:00$/);
      expect(await inv(id)).toMatchObject({
        status: 'partially_paid',
        paid_amount: '500000',
      });
      expect(
        await q(
          `select kind, amount::text from revenue_ledger where payment_id = $1 order by kind`,
          [p2.payment.id],
        ),
      ).toEqual([
        { kind: 'payment', amount: '700000' },
        { kind: 'reversal', amount: '-700000' },
      ]);
      const au = await q(
        `select actor_user_id, after_data from audit_logs where entity = 'payment' and entity_id = $1 and action = 'update'`,
        [p2.payment.id],
      );
      expect(au).toHaveLength(1);
      expect(au[0].actor_user_id).toBe(A.userId);
      expect(au[0].after_data.reason).toBe('Ghi nhầm hóa đơn');

      // Dòng đảo mang ngày thu gốc (hủy là sửa sai, doanh thu năm đó không còn khoản này).
      const rv = await q(
        `select entry_date::text, fiscal_year from revenue_ledger where payment_id = $1 and kind = 'reversal'`,
        [p2.payment.id],
      );
      expect(rv[0].fiscal_year).toBe(
        Number(localDate(new Date(), 'Asia/Ho_Chi_Minh').slice(0, 4)),
      );

      const v1 = await voidPay(A, p1.payment.id, 'Ghi nhầm');
      expect(v1.json()).toMatchObject({
        status: 'issued',
        paidAmount: 0,
        remainingAmount: 1_200_000,
      });
      expect((await inv(id)).status).toBe('issued');
      // Hủy xong lại thu được.
      const again = await pay(A, id, { amount: 1_200_000, method: 'cash' });
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json().status).toBe('paid');
    });

    it('hủy lại thanh toán đã hủy → 200, giữ lý do và người hủy ban đầu, không bút toán thứ hai', async () => {
      const { id } = await mkInvoice(A, 400_000);
      const p = (
        await pay(A, id, { amount: 400_000, method: 'cash' })
      ).json() as Res;
      const first = await voidPay(A, p.payment.id, 'Lý do đầu');
      const second = await voidPay(A, p.payment.id, 'Lý do khác');
      expect(second.statusCode, second.body).toBe(200);
      expect((second.json() as Res).payment).toMatchObject({
        voidReason: 'Lý do đầu',
        voidedAt: (first.json() as Res).payment.voidedAt,
      });
      expect(
        await q(`select 1 from revenue_ledger where payment_id = $1`, [
          p.payment.id,
        ]),
      ).toHaveLength(2);
      expect(
        await q(
          `select 1 from audit_logs where entity = 'payment' and entity_id = $1 and action = 'update'`,
          [p.payment.id],
        ),
      ).toHaveLength(1);
      // Trạng thái trả về là hiện tại của hóa đơn.
      expect(second.json()).toMatchObject({ status: 'issued', paidAmount: 0 });
    });

    it('hủy khoản đã trả thừa: ghi nợ sổ học viên đúng phần đã ghi có; thu nhiều lần', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const p1 = (
        await pay(A, id, { amount: 600_000, method: 'cash' })
      ).json() as Res;
      const p2 = (
        await pay(A, id, { amount: 900_000, method: 'cash' })
      ).json() as Res;
      expect(p2).toMatchObject({
        status: 'paid',
        paidAmount: 1_500_000,
        overpaidAmount: 500_000,
      });
      expect(await studentBalance(id)).toBe(500_000);

      const v = (await voidPay(A, p1.payment.id, 'nhầm')).json() as Res;
      expect(v).toMatchObject({
        status: 'partially_paid',
        paidAmount: 900_000,
        overpaidAmount: 0,
      });
      expect(await studentBalance(id)).toBe(0);
      expect(
        await q(
          `select kind, debit::text, credit::text from student_ledger where invoice_id = $1 order by kind`,
          [id],
        ),
      ).toEqual([
        { kind: 'overpayment', debit: '0', credit: '500000' },
        { kind: 'payment_void', debit: '500000', credit: '0' },
      ]);
    });

    it('lý do bắt buộc và ≤ 300 ký tự, Idempotency-Key bắt buộc → 422; không đổi gì', async () => {
      const { id } = await mkInvoice(A, 400_000);
      const p = (
        await pay(A, id, { amount: 100_000, method: 'cash' })
      ).json() as Res;
      for (const [body, key] of [
        [{}, undefined],
        [{ reason: '   ' }, undefined],
        [{ reason: 'x'.repeat(301) }, undefined],
        [{ reason: 'ok' }, null],
      ] as [object, string | null | undefined][]) {
        const r = await call(
          A.token,
          'POST',
          `/payments/${p.payment.id}/void`,
          body,
          key,
        );
        expect(r.statusCode, JSON.stringify(body)).toBe(422);
      }
      expect((await inv(id)).paid_amount).toBe('100000');
    });
  });

  describe('AC-4: danh sách và các trường trên hóa đơn', () => {
    it('GET /invoices/{id}/payments mới trước, gồm đã hủy kèm voidedBy; hóa đơn chưa thu → rỗng; nháp → 404', async () => {
      const { id } = await mkInvoice(A, 1_200_000);
      expect(
        (await call(A.token, 'GET', `/invoices/${id}/payments`)).json(),
      ).toEqual({ items: [] });
      const p1 = (
        await pay(A, id, {
          amount: 300_000,
          method: 'cash',
          paidOn: '2026-10-05',
        })
      ).json() as Res;
      const p2 = (
        await pay(A, id, { amount: 200_000, method: 'bank_transfer' })
      ).json() as Res;
      await voidPay(A, p1.payment.id, 'nhầm');
      const list = await call(A.token, 'GET', `/invoices/${id}/payments`);
      expect(list.statusCode, list.body).toBe(200);
      const items = list.json().items as Res['payment'][];
      expect(items.map((i) => i.id)).toEqual([p2.payment.id, p1.payment.id]);
      expect(items[0]).toMatchObject({
        voidedAt: null,
        recordedBy: { name: 'Cô Lan' },
      });
      expect(items[1]).toMatchObject({
        voidReason: 'nhầm',
        voidedBy: { id: A.userId, name: 'Cô Lan' },
      });
      const draft = await mkInvoice(A, 100_000, 'draft');
      expect(
        (await call(A.token, 'GET', `/invoices/${draft.id}/payments`))
          .statusCode,
      ).toBe(404);
    });

    it('S5: recordedBy/voidedBy là ảnh chụp tên lúc ghi/hủy, không đổi khi user đổi tên hoặc bị xóa', async () => {
      const O = await (async (): Promise<Who> => {
        const st = await seedTenant(t.worker);
        await q(`update users set display_name = 'Cô Mai' where id = $1`, [
          st.userId,
        ]);
        return { ...st, token: await t.tokenFor(st.userId) };
      })();
      const { id } = await mkInvoice(O, 100_000);
      const p = (
        await pay(O, id, { amount: 50_000, method: 'cash' })
      ).json() as Res;
      await voidPay(O, p.payment.id, 'nhầm');
      await q(
        `update users set display_name = 'Tên mới', deleted_at = now() where id = $1`,
        [O.userId],
      );
      await q(`update memberships set status = 'removed' where user_id = $1`, [
        O.userId,
      ]).catch(() => undefined);
      const rows = await q(
        `select recorded_by_name, voided_by_name from payments where id = $1`,
        [p.payment.id],
      );
      expect(rows[0]).toEqual({
        recorded_by_name: 'Cô Mai',
        voided_by_name: 'Cô Mai',
      });
      expect(p.payment.recordedBy).toEqual({ id: O.userId, name: 'Cô Mai' });
    });

    it('Invoice: paidAmount/remainingAmount thật ở GET /invoices/{id}; void/draft → remainingAmount 0', async () => {
      const { id } = await mkInvoice(A, 1_200_000);
      await pay(A, id, { amount: 500_000, method: 'cash' });
      expect(
        (await call(A.token, 'GET', `/invoices/${id}`)).json(),
      ).toMatchObject({
        status: 'partially_paid',
        paidAmount: 500_000,
        remainingAmount: 700_000,
      });
      await pay(A, id, { amount: 900_000, method: 'cash' });
      expect(
        (await call(A.token, 'GET', `/invoices/${id}`)).json(),
      ).toMatchObject({
        status: 'paid',
        paidAmount: 1_400_000,
        remainingAmount: 0,
      });
      const d = await mkInvoice(A, 100_000, 'draft');
      const v = await mkInvoice(A, 100_000, 'void');
      expect(
        (await call(A.token, 'GET', `/invoices/${d.id}`)).json(),
      ).toMatchObject({ paidAmount: 0, remainingAmount: 0 });
      expect(
        (await call(A.token, 'GET', `/invoices/${v.id}`)).json(),
      ).toMatchObject({ paidAmount: 0, remainingAmount: 0 });
    });
  });

  describe('AC-4/AC-5: phụ huynh (biên nhận)', () => {
    type Parent = { userId: string; token: string };
    const mkParent = async (): Promise<Parent> => {
      const userId = randomUUID();
      await q(
        `insert into users (id, email, display_name) values ($1, $2, 'PH')`,
        [userId, `${userId}@example.com`],
      );
      const token = await t.tokenFor(userId);
      await call(token, 'POST', '/consents', {
        role: 'parent',
        termsVersion: TERMS,
      });
      return { userId, token };
    };
    /** Học viên của `who` liên kết với phụ huynh `p` qua lời mời thật. */
    const child = async (who: Who, p: Parent) => {
      const st = await call(who.token, 'POST', '/students', {
        fullName: 'Lê Gia Bảo',
        dob: '2012-05-05',
        notes: 'ghi chú riêng của giáo viên',
        guardians: [
          { fullName: 'Lê Văn A', relation: 'father', phone: '0912345678' },
        ],
      });
      const s = st.json() as { id: string; guardians: { id: string }[] };
      const invite = await call(
        who.token,
        'POST',
        `/students/${s.id}/invites`,
        { guardianId: s.guardians[0]!.id },
      );
      const acc = await call(p.token, 'POST', '/invites/accept', {
        token: invite.json().token,
      });
      expect(acc.statusCode, acc.body).toBe(200);
      return s.id;
    };

    it('/family/invoices: paidAmount/remainingAmount và payments (kể cả đã hủy); không ghi chú, người ghi, lý do hủy; phụ huynh khác 404', async () => {
      const p = await mkParent();
      const stu = await child(A, p);
      const other = await mkParent();
      await child(B, other);
      const { id } = await mkInvoice(A, 1_200_000, 'issued', stu);
      const p1 = (
        await pay(A, id, {
          amount: 300_000,
          method: 'cash',
          paidOn: '2026-10-05',
          note: 'GHI CHÚ NỘI BỘ',
        })
      ).json() as Res;
      const p2 = (
        await pay(A, id, { amount: 200_000, method: 'bank_transfer' })
      ).json() as Res;
      await voidPay(A, p1.payment.id, 'LÝ DO HỦY NỘI BỘ');

      const det = await call(p.token, 'GET', `/family/invoices/${id}`);
      expect(det.statusCode, det.body).toBe(200);
      const d = det.json();
      expect(d).toMatchObject({
        status: 'partially_paid',
        paidAmount: 200_000,
        remainingAmount: 1_000_000,
      });
      expect(d.payments.map((x: { id: string }) => x.id)).toEqual([
        p2.payment.id,
        p1.payment.id,
      ]);
      expect(d.payments[0]).toEqual({
        id: p2.payment.id,
        amount: 200_000,
        method: 'bank_transfer',
        paidOn: localDate(new Date(), 'Asia/Ho_Chi_Minh'),
        recordedAt: expect.stringMatching(/\+07:00$/),
        voidedAt: null,
      });
      expect(d.payments[1]).toMatchObject({
        amount: 300_000,
        voidedAt: expect.stringMatching(/\+07:00$/),
      });
      expect(det.body).not.toMatch(
        /GHI CHÚ NỘI BỘ|LÝ DO HỦY|recordedBy|voidedBy|voidReason|"note"/,
      );
      const list = (await call(p.token, 'GET', '/family/invoices')).json();
      expect(list.items[0]).toMatchObject({
        paidAmount: 200_000,
        remainingAmount: 1_000_000,
      });
      expect(JSON.stringify(list)).not.toMatch(/payments/);
      expect(
        (await call(other.token, 'GET', `/family/invoices/${id}`)).statusCode,
      ).toBe(404);
    });

    it('consumer payment_recorded: push data-only + một email biên nhận, không gửi trùng, nhận lại queued bỏ dở; không PII/số tiền; thanh toán đã hủy không báo', async () => {
      const { PaymentRecordedNotifier } =
        await import('../libs/modules/notifications/application/payment-recorded-notifier.service.js');
      const { AbsenceNotifier } =
        await import('../libs/modules/notifications/application/absence-notifier.service.js');
      const schema = await import('../libs/db/src/schema/index.js');
      const { TxService } = await import('../libs/db/src/tx.service.js');
      const pool = new pg.Pool({
        connectionString: t.db.url('teachhub_worker'),
      });
      const tx = new TxService(drizzle(pool, { schema, casing: 'snake_case' }));
      const pushed: { data: Record<string, string> }[] = [];
      const mails: { to: string; subject: string; text: string }[] = [];
      const notifier = new PaymentRecordedNotifier(
        tx,
        new AbsenceNotifier(tx, {
          enabled: true,
          send: (ms: { data: Record<string, string> }[]) => {
            pushed.push(...ms);
            return Promise.resolve(
              ms.map(() => ({ ok: true as const, messageId: 'm' })),
            );
          },
        } as never),
        {
          send: (m: (typeof mails)[number]) => {
            mails.push(m);
            return Promise.resolve();
          },
        } as never,
      );
      const parent = randomUUID();
      await q(`insert into users (id, email) values ($1, $2)`, [
        parent,
        `${parent}@example.com`,
      ]);
      await q(
        `insert into devices (id, user_id, platform, token) values ($1, $2, 'android', $3)`,
        [randomUUID(), parent, `tok-${parent}`],
      );
      await q(
        `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
        [randomUUID(), parent],
      );
      const { id, studentId } = await mkInvoice(A, 900_000);
      await q(
        `insert into guardians (id, tenant_id, student_id, full_name, email, user_id) values ($1, $2, $3, 'PH', 'ph@example.com', $4)`,
        [randomUUID(), A.tenantId, studentId, parent],
      );
      const p1 = (
        await pay(A, id, { amount: 300_000, method: 'cash' })
      ).json() as Res;
      const p2 = (
        await pay(A, id, { amount: 100_000, method: 'cash' })
      ).json() as Res;
      await voidPay(A, p2.payment.id, 'nhầm');
      const jobs = (
        await q(
          `select id, tenant_id, payload from outbox_events where type = 'payment_recorded' and payload->>'invoiceId' = $1 order by created_at`,
          [id],
        )
      ).map((r) => ({
        eventId: r.id,
        tenantId: r.tenant_id,
        payload: r.payload,
      }));
      expect(jobs).toHaveLength(2);

      await notifier.handle(jobs[0]);
      await notifier.handle(jobs[0]);
      const notes = await q(
        `select type, urgency, payload from notifications where recipient_user_id = $1`,
        [parent],
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        type: 'payment_recorded',
        urgency: 'normal',
      });
      expect(notes[0].payload).toEqual({
        invoiceId: id,
        paymentId: p1.payment.id,
        studentId,
        studentName: 'Lê Gia Bảo',
        amount: 300_000,
        paidOn: localDate(new Date(), 'Asia/Ho_Chi_Minh'),
        status: 'partially_paid',
        remainingAmount: 600_000,
      });
      expect(pushed).toHaveLength(1);
      expect(Object.keys(pushed[0]!.data).sort()).toEqual([
        'notificationId',
        'type',
      ]);
      expect(JSON.stringify(pushed)).not.toMatch(/Lê Gia Bảo|300000|300\.000/);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe('ph@example.com');
      expect(mails[0]!.subject + mails[0]!.text).not.toMatch(/Lê Gia Bảo|300/);

      // Email `queued` bỏ dở quá 2 phút được nhận lại và gửi; push đã `sent` thì không gửi lại.
      await q(
        `update notification_deliveries set status = 'queued', created_at = now() - interval '3 minutes' where channel = 'email'`,
      );
      await notifier.handle(jobs[0]);
      expect(mails).toHaveLength(2);
      expect(pushed).toHaveLength(1);
      // `queued` còn mới: người khác đang gửi, không gửi trùng.
      await q(
        `update notification_deliveries set status = 'queued', created_at = now() where channel = 'email'`,
      );
      await notifier.handle(jobs[0]);
      expect(mails).toHaveLength(2);

      // S6: phụ huynh đã gỡ liên kết (guardian đã xóa) hoặc con đã nghỉ không nhận thông báo/email.
      const unlinked = await mkInvoice(A, 200_000);
      const gid = randomUUID();
      await q(
        `insert into guardians (id, tenant_id, student_id, full_name, email, user_id, deleted_at) values ($1, $2, $3, 'PH cũ', 'cu@example.com', $4, now())`,
        [gid, A.tenantId, unlinked.studentId, parent],
      );
      const left = await mkInvoice(A, 200_000);
      await q(
        `insert into guardians (id, tenant_id, student_id, full_name, email, user_id) values ($1, $2, $3, 'PH', 'ph@example.com', $4)`,
        [randomUUID(), A.tenantId, left.studentId, parent],
      );
      await pay(A, unlinked.id, { amount: 10_000, method: 'cash' });
      await pay(A, left.id, { amount: 10_000, method: 'cash' });
      await q(`update students set status = 'left' where id = $1`, [
        left.studentId,
      ]);
      const extra = (
        await q(
          `select id, tenant_id, payload from outbox_events where type = 'payment_recorded' and payload->>'invoiceId' = any($1)`,
          [[unlinked.id, left.id]],
        )
      ).map((r) => ({
        eventId: r.id,
        tenantId: r.tenant_id,
        payload: r.payload,
      }));
      expect(extra).toHaveLength(2);
      const mailsBefore = mails.length;
      for (const j of extra) await notifier.handle(j);
      expect(mails).toHaveLength(mailsBefore);
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          parent,
        ]),
      ).toHaveLength(1);

      // Thanh toán đã hủy trước khi worker xử lý: không báo.
      await notifier.handle(jobs[1]);
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          parent,
        ]),
      ).toHaveLength(1);
      await pool.end();
    });
  });

  describe('S1/S2/S7: ngày thu, hóa đơn chờ xác nhận, song song với hủy hóa đơn', () => {
    it('S1: paidOn phải từ ngày phát hành (múi giờ tenant) đến hôm nay; sai → 422 ở paidOn, không 500', async () => {
      const today = localDate(new Date(), 'Asia/Ho_Chi_Minh');
      // Phát hành 2026-03-10T18:00Z = 01:00 ngày 11 theo giờ VN.
      const { id } = await mkInvoice(
        A,
        1_000_000,
        'issued',
        undefined,
        '2026-03-10T18:00:00Z',
      );
      for (const paidOn of [
        '2026-03-10',
        '0000-01-01',
        '1900-01-01',
        '2999-12-31',
      ]) {
        const r = await pay(A, id, { amount: 1000, method: 'cash', paidOn });
        expect(r.statusCode, paidOn).toBe(422);
        expect(r.json().code).toBe('VALIDATION_FAILED');
        expect(r.json().errors).toHaveProperty('paidOn');
      }
      for (const paidOn of ['2026-03-11', today]) {
        const r = await pay(A, id, { amount: 1000, method: 'cash', paidOn });
        expect(r.statusCode, paidOn).toBe(201);
      }
      expect(
        await q(`select 1 from payments where invoice_id = $1`, [id]),
      ).toHaveLength(2);
    });

    it('S2: hủy thanh toán trên hóa đơn pending_confirmation giữ pending_confirmation; ghi thu chuyển partially_paid/paid', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const p = (
        await pay(A, id, { amount: 300_000, method: 'cash' })
      ).json() as Res;
      await q(
        `update invoices set status = 'pending_confirmation' where id = $1`,
        [id],
      );
      const v = await voidPay(A, p.payment.id, 'nhầm');
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json()).toMatchObject({
        status: 'pending_confirmation',
        paidAmount: 0,
        remainingAmount: 1_000_000,
      });
      expect(await inv(id)).toMatchObject({
        status: 'pending_confirmation',
        paid_amount: '0',
      });
      const r = await pay(A, id, { amount: 400_000, method: 'cash' });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().status).toBe('partially_paid');
      await q(
        `update invoices set status = 'pending_confirmation' where id = $1`,
        [id],
      );
      const r2 = await pay(A, id, { amount: 600_000, method: 'cash' });
      expect(r2.json()).toMatchObject({
        status: 'paid',
        paidAmount: 1_000_000,
      });
    });

    it('S7: thu và hủy hóa đơn song song trên hóa đơn issued: một bên thắng, bên kia 409, dữ liệu nhất quán', async () => {
      for (let i = 0; i < 3; i++) {
        const { id } = await mkInvoice(A, 500_000);
        const [a, b] = await Promise.all([
          pay(A, id, { amount: 500_000, method: 'cash' }),
          call(A.token, 'POST', `/invoices/${id}/void`, { reason: 'nhầm' }),
        ]);
        const codes = [a.statusCode, b.statusCode];
        expect(codes.filter((c) => c === 409)).toHaveLength(1);
        const row = await inv(id);
        if (a.statusCode === 201) {
          expect(b.statusCode).toBe(409);
          expect(row).toMatchObject({ status: 'paid', paid_amount: '500000' });
        } else {
          expect(a.json().code).toBe('INVOICE_NOT_PAYABLE');
          expect(row).toMatchObject({ status: 'void', paid_amount: '0' });
          expect(
            await q(`select 1 from payments where invoice_id = $1`, [id]),
          ).toHaveLength(0);
        }
      }
    });
  });

  describe('S6: invoice_issued cũng không báo phụ huynh đã gỡ liên kết hoặc con đã nghỉ', () => {
    it('guardian đã xóa / học viên left → không thông báo, không email', async () => {
      const { InvoiceIssuedNotifier } =
        await import('../libs/modules/notifications/application/invoice-issued-notifier.service.js');
      const { AbsenceNotifier } =
        await import('../libs/modules/notifications/application/absence-notifier.service.js');
      const schema = await import('../libs/db/src/schema/index.js');
      const { TxService } = await import('../libs/db/src/tx.service.js');
      const pool = new pg.Pool({
        connectionString: t.db.url('teachhub_worker'),
      });
      const tx = new TxService(drizzle(pool, { schema, casing: 'snake_case' }));
      const mails: unknown[] = [];
      const notifier = new InvoiceIssuedNotifier(
        tx,
        new AbsenceNotifier(tx, {
          enabled: false,
          send: () => Promise.resolve([]),
        } as never),
        { send: (m: unknown) => (mails.push(m), Promise.resolve()) } as never,
      );
      const parent = randomUUID();
      await q(`insert into users (id, email) values ($1, $2)`, [
        parent,
        `${parent}@example.com`,
      ]);
      await q(
        `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
        [randomUUID(), parent],
      );
      const run = async (setup: (studentId: string) => Promise<void>) => {
        const { id, studentId } = await mkInvoice(A, 200_000);
        await setup(studentId);
        await notifier
          .handle({
            eventId: randomUUID(),
            tenantId: A.tenantId,
            payload: {
              invoiceId: id,
              studentId,
              periodMonth: '2026-12-01',
              totalAmount: 200_000,
              dueDate: '2027-01-10',
            },
          })
          .catch(() => undefined);
      };
      await run((st) =>
        q(
          `insert into guardians (id, tenant_id, student_id, full_name, email, user_id, deleted_at) values ($1, $2, $3, 'PH', 'a@example.com', $4, now())`,
          [randomUUID(), A.tenantId, st, parent],
        ).then(() => undefined),
      );
      await run(async (st) => {
        await q(
          `insert into guardians (id, tenant_id, student_id, full_name, email, user_id) values ($1, $2, $3, 'PH', 'b@example.com', $4)`,
          [randomUUID(), A.tenantId, st, parent],
        );
        await q(`update students set status = 'left' where id = $1`, [st]);
      });
      expect(mails).toHaveLength(0);
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          parent,
        ]),
      ).toHaveLength(0);
      await pool.end();
    });
  });

  describe('AC-6: đối soát, song song, gửi lặp', () => {
    it('chuỗi thu đủ, thu một phần, trả thừa, hủy: Σ thanh toán còn hiệu lực = Σ paidAmount hóa đơn = Σ revenue_ledger; sổ học viên khớp từng hóa đơn', async () => {
      const C = await (async (): Promise<Who> => {
        const s = await seedTenant(t.worker);
        return { ...s, token: await t.tokenFor(s.userId) };
      })();
      const full = await mkInvoice(C, 1_000_000);
      const part = await mkInvoice(C, 2_000_000);
      const over = await mkInvoice(C, 500_000);
      const voidAll = await mkInvoice(C, 800_000);
      const untouched = await mkInvoice(C, 300_000);

      await pay(C, full.id, { amount: 1_000_000, method: 'bank_transfer' });
      await pay(C, part.id, { amount: 750_000, method: 'cash' });
      const o1 = (
        await pay(C, over.id, { amount: 200_000, method: 'cash' })
      ).json() as Res;
      const o2 = (
        await pay(C, over.id, { amount: 700_000, method: 'cash' })
      ).json() as Res;
      const v1 = (
        await pay(C, voidAll.id, { amount: 800_000, method: 'cash' })
      ).json() as Res;
      const v2 = (
        await pay(C, part.id, { amount: 100_000, method: 'cash' })
      ).json() as Res;
      expect(o2.overpaidAmount).toBe(400_000);
      await voidPay(C, v1.payment.id, 'nhầm 1');
      await voidPay(C, v2.payment.id, 'nhầm 2');
      await voidPay(C, o1.payment.id, 'nhầm 3'); // hủy khoản nhỏ: 700k vẫn > 500k, thừa còn 200k

      const sums = await reconcile(C.tenantId);
      expect(sums).toEqual({
        payments: 1_000_000 + 750_000 + 700_000,
        invoices: 2_450_000,
        revenue: 2_450_000,
      });
      // Từng hóa đơn: paid_amount = Σ thanh toán còn hiệu lực = Σ doanh thu; sổ học viên = phần thừa.
      const rows = await q(
        `select i.id, i.total_amount::bigint as total, i.paid_amount::bigint as paid,
           coalesce((select sum(amount) from payments p where p.invoice_id = i.id and p.voided_at is null), 0)::bigint as pay_sum,
           coalesce((select sum(r.amount) from revenue_ledger r join payments p on p.id = r.payment_id where p.invoice_id = i.id), 0)::bigint as rev_sum
           from invoices i where i.tenant_id = $1`,
        [C.tenantId],
      );
      for (const r of rows) {
        expect(Number(r.pay_sum), r.id).toBe(Number(r.paid));
        expect(Number(r.rev_sum), r.id).toBe(Number(r.paid));
        expect(await studentBalance(r.id), r.id).toBe(
          Math.max(0, Number(r.paid) - Number(r.total)),
        );
      }
      expect((await inv(untouched.id)).status).toBe('issued');
      expect((await inv(voidAll.id)).status).toBe('issued');
      expect((await inv(part.id)).status).toBe('partially_paid');
      expect((await inv(over.id)).status).toBe('paid');
    });

    it('hai (năm) request song song cùng hóa đơn: đúng một thanh toán đủ, còn lại 409; không ghi quá', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const rs = await Promise.all(
        Array.from({ length: 5 }, () =>
          pay(A, id, { amount: 1_000_000, method: 'cash' }),
        ),
      );
      expect(rs.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([
        201, 409, 409, 409, 409,
      ]);
      expect(
        await q(`select 1 from payments where invoice_id = $1`, [id]),
      ).toHaveLength(1);
      expect(await inv(id)).toMatchObject({
        status: 'paid',
        paid_amount: '1000000',
      });
    });

    it('song song thu một phần: tổng khớp từng khoản đã nhận, trạng thái đúng', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const rs = await Promise.all(
        Array.from({ length: 4 }, () =>
          pay(A, id, { amount: 300_000, method: 'cash' }),
        ),
      );
      // 300k x 3 = 900k (partially), lần thứ tư đưa lên 1,2 tr (paid, thừa 200k): cả bốn đều hợp lệ.
      expect(rs.every((r) => r.statusCode === 201)).toBe(true);
      expect(await inv(id)).toMatchObject({
        status: 'paid',
        paid_amount: '1200000',
      });
      expect(await studentBalance(id)).toBe(200_000);
      const after = await q(
        `select count(*)::int as n from payments where invoice_id = $1`,
        [id],
      );
      expect(after[0].n).toBe(4);
    });

    it('gửi lặp cùng Idempotency-Key (tuần tự và song song) → một thanh toán, cùng kết quả', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const key = randomUUID();
      const first = await pay(A, id, { amount: 400_000, method: 'cash' }, key);
      const second = await pay(A, id, { amount: 400_000, method: 'cash' }, key);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      expect(second.headers['idempotent-replayed']).toBe('true');
      // Cùng khóa khác nội dung → 422.
      const reused = await pay(A, id, { amount: 1, method: 'cash' }, key);
      expect(reused.statusCode).toBe(422);
      expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');

      const k2 = randomUUID();
      const par = await Promise.all([
        pay(A, id, { amount: 100_000, method: 'cash' }, k2),
        pay(A, id, { amount: 100_000, method: 'cash' }, k2),
        pay(A, id, { amount: 100_000, method: 'cash' }, k2),
      ]);
      expect(
        par.map((r) => r.statusCode).every((c) => c === 201 || c === 409),
      ).toBe(true);
      expect(
        par.filter((r) => r.statusCode === 201).length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        await q(`select 1 from payments where invoice_id = $1`, [id]),
      ).toHaveLength(2);
      expect((await inv(id)).paid_amount).toBe('500000');

      // Hủy: gửi lặp cùng khóa → phát lại, một bút toán đảo.
      const p = (first.json() as Res).payment.id;
      const kv = randomUUID();
      const v1 = await voidPay(A, p, 'nhầm', kv);
      const v2 = await voidPay(A, p, 'nhầm', kv);
      expect(v2.json()).toEqual(v1.json());
      expect(
        await q(
          `select 1 from revenue_ledger where payment_id = $1 and kind = 'reversal'`,
          [p],
        ),
      ).toHaveLength(1);
    });

    it('thu và hủy song song cùng hóa đơn không làm lệch sổ', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const p = (
        await pay(A, id, { amount: 400_000, method: 'cash' })
      ).json() as Res;
      await Promise.all([
        voidPay(A, p.payment.id, 'a'),
        voidPay(A, p.payment.id, 'b'),
        pay(A, id, { amount: 250_000, method: 'cash' }),
      ]);
      const row = await inv(id);
      expect(row.paid_amount).toBe('250000');
      const sums = await q(
        `select
           (select coalesce(sum(amount),0) from payments where invoice_id = $1 and voided_at is null)::bigint as p,
           (select coalesce(sum(r.amount),0) from revenue_ledger r join payments x on x.id = r.payment_id where x.invoice_id = $1)::bigint as r`,
        [id],
      );
      expect(sums[0]).toEqual({ p: '250000', r: '250000' });
    });
  });

  describe('AC-7: cô lập tenant và quyền', () => {
    it('tenant B không ghi, đọc, hủy thanh toán/hóa đơn của A (404, dữ liệu A không đổi); id lạ cũng 404', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const p = (
        await pay(A, id, { amount: 400_000, method: 'cash' })
      ).json() as Res;
      const before = await reconcile(A.tenantId);

      expect(
        (await pay(B, id, { amount: 100, method: 'cash' })).statusCode,
      ).toBe(404);
      expect(
        (await call(B.token, 'GET', `/invoices/${id}/payments`)).statusCode,
      ).toBe(404);
      expect((await voidPay(B, p.payment.id, 'x')).statusCode).toBe(404);
      for (const r of [
        await pay(A, randomUUID(), { amount: 100, method: 'cash' }),
        await call(A.token, 'GET', `/invoices/${randomUUID()}/payments`),
        await voidPay(A, randomUUID(), 'x'),
      ])
        expect(r.statusCode).toBe(404);
      expect(await reconcile(A.tenantId)).toEqual(before);
      expect(await inv(id)).toMatchObject({
        status: 'partially_paid',
        paid_amount: '400000',
      });
      expect(
        (
          await q(`select voided_at from payments where id = $1`, [
            p.payment.id,
          ])
        )[0].voided_at,
      ).toBeNull();
    });

    it('chỉ chủ tenant ghi: giáo viên thường, phụ huynh, không token → 403/401', async () => {
      const { id } = await mkInvoice(A, 1_000_000);
      const p = (
        await pay(A, id, { amount: 400_000, method: 'cash' })
      ).json() as Res;
      const parent = randomUUID();
      await q(`insert into users (id, email) values ($1, $2)`, [
        parent,
        `${parent}@example.com`,
      ]);
      await q(
        `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
        [randomUUID(), parent],
      );
      const parentToken = await t.tokenFor(parent);
      for (const token of [teacherToken, parentToken]) {
        for (const r of [
          await pay({ token }, id, { amount: 100, method: 'cash' }),
          await call(token, 'GET', `/invoices/${id}/payments`),
          await voidPay({ token }, p.payment.id, 'x'),
        ])
          expect(r.statusCode).toBe(403);
      }
      expect(
        (await call(null, 'GET', `/invoices/${id}/payments`)).statusCode,
      ).toBe(401);
      expect((await inv(id)).paid_amount).toBe('400000');
    });
  });
});
