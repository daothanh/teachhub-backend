import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { migrateTestDb, startTestDb, type TestDb } from './containers.js';
import { expectInsertRejected } from './support/isolation.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

/** Bản sao thư mục migration chỉ gồm các migration trước 0026. */
function migrationsBefore0026(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  cpSync('libs/db/migrations', dir, { recursive: true });
  const old = JSON.parse(
    readFileSync('libs/db/migrations/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  mkdirSync(join(dir, 'before'));
  const before = join(dir, 'before');
  cpSync(join(dir, 'meta'), join(before, 'meta'), { recursive: true });
  for (const e of old.entries.filter((x) => Number(x.tag.slice(0, 4)) < 26))
    cpSync(join(dir, `${e.tag}.sql`), join(before, `${e.tag}.sql`));
  writeFileSync(
    join(before, 'meta/_journal.json'),
    JSON.stringify({
      ...old,
      entries: old.entries.filter((x) => Number(x.tag.slice(0, 4)) < 26),
    }),
  );
  return before;
}

// S6-BE-01: payments, student_ledger, revenue_ledger: RLS chéo tenant và phụ huynh, ràng buộc, chỉ ghi thêm, bất biến.
describe('payments schema: RLS, ràng buộc, chỉ ghi thêm', () => {
  let db: TestDb;
  let worker: pg.Pool;
  let owner: pg.Pool;
  let appPool: pg.Pool;
  let tx: TxService;
  let A: SeededTenant;
  let B: SeededTenant;
  let parentX: string;
  let parentY: string;
  const ids = {
    stuX: randomUUID(),
    stuY: randomUUID(),
    stuB: randomUUID(),
    period: randomUUID(),
    periodB: randomUUID(),
    inv: randomUUID(),
    invB: randomUUID(),
    pay: randomUUID(),
    payB: randomUUID(),
  };

  const asUser = async (userId: string | null, q: ReturnType<typeof sql>) =>
    tx.run({ userId }, async (t) => (await t.execute(q)).rows);
  const q = async (text: string, params: unknown[] = []) =>
    (await worker.query(text, params)).rows;
  const fail = async (p: Promise<unknown>) => {
    const e: unknown = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e, 'phải lỗi').not.toBeNull();
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ''}`;
  };
  /** Chạy `stmt` bằng owner (có quyền bảng) khi đã tắt FORCE RLS trong giao dịch rồi rollback: lộ ra trigger, không bị RLS ẩn dòng. */
  const asOwnerNoRls = async (
    table: string,
    stmt: string,
    params: unknown[],
  ) => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(`alter table ${table} no force row level security`);
      return await fail(c.query(stmt, params));
    } finally {
      await c.query('rollback');
      c.release();
    }
  };
  const issue = (id: string, code: string) =>
    q(
      `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
         payout = '{"bankBin":"970436","accountNo":"0123456789","accountName":"A"}'::jsonb, issued_at = now() where id = $1`,
      [id, code, code.replace('-', ' ')],
    );
  const inTx = async (fn: (c: pg.PoolClient) => Promise<void>) => {
    const c = await worker.connect();
    try {
      await c.query('begin');
      await fn(c);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  };
  /** paid_amount/status theo Σ thanh toán chưa hủy (đúng việc service làm), trong cùng giao dịch với lệnh ghi/hủy. */
  const sync = (c: pg.PoolClient, inv: string) =>
    c.query(
      `update invoices i set paid_amount = s.p,
         status = case when s.p <= 0 then 'issued' when s.p >= i.total_amount then 'paid' else 'partially_paid' end
       from (select coalesce(sum(amount) filter (where voided_at is null), 0) p from payments where invoice_id = $1) s
       where i.id = $1`,
      [inv],
    );
  const payment = (
    id: string,
    inv: string,
    tenantId: string,
    by: string,
    amount = 500_000,
  ) =>
    inTx(async (c) => {
      await c.query(
        `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name)
         values ($1, $2, $3, $4, 'cash', '2027-01-05', $5, 'Cô Lan')`,
        [id, tenantId, inv, amount, by],
      );
      await c.query(
        `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
         values ($1, $2, $3, 'payment', $4, '2027-01-05', 2027)`,
        [randomUUID(), tenantId, id, amount],
      );
      await sync(c, inv);
    });
  const voidPayment = (id: string, inv: string, reason: string, by: string) =>
    inTx(async (c) => {
      await c.query(
        `update payments set voided_at = now(), void_reason = $2, voided_by = $3, voided_by_name = 'Cô Lan' where id = $1`,
        [id, reason, by],
      );
      await c.query(
        `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
         select $2, tenant_id, id, 'reversal', -amount, paid_on, extract(year from paid_on)::int from payments where id = $1`,
        [id, randomUUID()],
      );
      await sync(c, inv);
    });

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    owner = new pg.Pool({ connectionString: db.url('teachhub_owner') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    A = await seedTenant(worker);
    B = await seedTenant(worker);
    parentX = randomUUID();
    parentY = randomUUID();
    for (const p of [parentX, parentY])
      await q(`insert into users (id, email) values ($1, $2)`, [
        p,
        `${p}@example.com`,
      ]);
    for (const [stu, tenant, parent] of [
      [ids.stuX, A.tenantId, parentX],
      [ids.stuY, A.tenantId, parentY],
      [ids.stuB, B.tenantId, null],
    ] as const) {
      await q(
        `insert into students (id, tenant_id, full_name) values ($1, $2, 'HV')`,
        [stu, tenant],
      );
      if (parent)
        await q(
          `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'PH', $4)`,
          [randomUUID(), tenant, stu, parent],
        );
    }
    for (const [period, tenant] of [
      [ids.period, A.tenantId],
      [ids.periodB, B.tenantId],
    ] as const)
      await q(
        `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, '2026-12-01', '2026-12-31', '2027-01-10')`,
        [period, tenant],
      );
    for (const [inv, tenant, period, stu, code] of [
      [ids.inv, A.tenantId, ids.period, ids.stuX, 'TH-25K7Q9'],
      [ids.invB, B.tenantId, ids.periodB, ids.stuB, 'TH-25K7Q8'],
    ] as const) {
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 1200000)`,
        [inv, tenant, period, stu],
      );
      await issue(inv, code);
    }
    await payment(ids.pay, ids.inv, A.tenantId, A.userId);
    await payment(ids.payB, ids.invB, B.tenantId, B.userId);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), owner?.end(), appPool?.end()]);
    await db?.container.stop();
  });

  describe('RLS', () => {
    it('payments: chủ tenant thấy, tenant khác và không có user thì không; sửa/ghi/xóa chéo bị chặn', async () => {
      const sel = sql`select 1 from payments where id = ${ids.pay}`;
      expect(await asUser(A.userId, sel)).toHaveLength(1);
      expect(await asUser(B.userId, sel)).toHaveLength(0);
      expect(await asUser(null, sel)).toHaveLength(0);
      expect(
        await asUser(
          B.userId,
          sql`update payments set voided_at = null where id = ${ids.pay} returning id`,
        ),
      ).toHaveLength(0);
      // Xóa: không có quyền DELETE ở mức bảng (kể cả chủ tenant).
      expect(
        await fail(
          asUser(A.userId, sql`delete from payments where id = ${ids.pay}`),
        ),
      ).toMatch(/permission denied/);
      await expectInsertRejected(
        tx,
        B.userId,
        sql`insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name)
          values (${randomUUID()}, ${A.tenantId}, ${ids.inv}, 1000, 'cash', '2027-01-05', ${B.userId}, 'x')`,
      );
    });

    it('FK ghép có tenant_id: không gắn thanh toán của tenant này vào hóa đơn tenant khác', async () => {
      expect(
        await fail(payment(randomUUID(), ids.invB, A.tenantId, A.userId)),
      ).toMatch(/payments_tenant_invoice_fk/);
    });

    it('payments: phụ huynh chỉ thấy của hóa đơn con mình; phụ huynh khác không; không ghi được', async () => {
      const sel = sql`select 1 from payments where id = ${ids.pay}`;
      expect(await asUser(parentX, sel)).toHaveLength(1);
      expect(await asUser(parentY, sel)).toHaveLength(0);
      await expectInsertRejected(
        tx,
        parentX,
        sql`insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name)
          values (${randomUUID()}, ${A.tenantId}, ${ids.inv}, 1000, 'cash', '2027-01-05', ${parentX}, 'x')`,
      );
      expect(
        await asUser(
          parentX,
          sql`update payments set voided_at = now() where id = ${ids.pay} returning id`,
        ),
      ).toHaveLength(0);
    });

    it('student_ledger và revenue_ledger: chủ tenant đọc/ghi trong tenant; chéo tenant, phụ huynh, không user → 0 dòng và ghi chéo bị chặn', async () => {
      const lid = randomUUID();
      const rid = (
        await q(`select id from revenue_ledger where payment_id = $1`, [
          ids.pay,
        ])
      )[0].id as string;
      await asUser(
        A.userId,
        sql`insert into student_ledger (id, tenant_id, student_id, invoice_id, payment_id, kind, credit, description)
          values (${lid}, ${A.tenantId}, ${ids.stuX}, ${ids.inv}, null, 'prev_adjustment', 100, 'x')`,
      );
      for (const [table, id] of [
        ['student_ledger', lid],
        ['revenue_ledger', rid],
      ] as const) {
        const sel = sql`select 1 from ${sql.identifier(table)} where id = ${id}`;
        expect(await asUser(A.userId, sel), `${table} chủ tenant`).toHaveLength(
          1,
        );
        expect(await asUser(B.userId, sel), `${table} chéo`).toHaveLength(0);
        expect(await asUser(parentX, sel), `${table} phụ huynh`).toHaveLength(
          0,
        );
        expect(await asUser(null, sel), `${table} không user`).toHaveLength(0);
      }
      await expectInsertRejected(
        tx,
        B.userId,
        sql`insert into student_ledger (id, tenant_id, student_id, kind, credit, description)
          values (${randomUUID()}, ${A.tenantId}, ${ids.stuX}, 'overpayment', 1, 'x')`,
        /row-level security|LEDGER_INVALID/,
      );
      await expectInsertRejected(
        tx,
        parentX,
        sql`insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
          values (${randomUUID()}, ${A.tenantId}, ${ids.pay}, 'reversal', -1, '2027-01-05', 2027)`,
        /row-level security|LEDGER_INVALID/,
      );
    });
  });

  describe('chỉ ghi thêm và bất biến', () => {
    let ledgerId: string;
    let revenueId: string;
    const revPay = randomUUID();
    beforeAll(async () => {
      ledgerId = randomUUID();
      await payment(revPay, ids.inv, A.tenantId, A.userId, 700);
      await q(
        `insert into student_ledger (id, tenant_id, student_id, kind, debit, description) values ($1, $2, $3, 'prev_adjustment', 50, 'x')`,
        [ledgerId, A.tenantId, ids.stuX],
      );
      revenueId = (
        await q(`select id from revenue_ledger where payment_id = $1`, [revPay])
      )[0].id as string;
    });

    it.each([
      ['revenue_ledger', 'update revenue_ledger set amount = 1 where id = $1'],
      ['revenue_ledger', 'delete from revenue_ledger where id = $1'],
      ['student_ledger', 'update student_ledger set debit = 1 where id = $1'],
      ['student_ledger', 'delete from student_ledger where id = $1'],
    ])(
      '%s: %s → lỗi: app và worker thiếu quyền, owner vướng trigger',
      async (table, stmt) => {
        const id = table === 'revenue_ledger' ? revenueId : ledgerId;
        expect(await fail(worker.query(stmt, [id]))).toMatch(
          /permission denied/,
        );
        // Vai trò app: thu quyền ở mức bảng.
        expect(
          await fail(asUser(A.userId, sql.raw(stmt.replace('$1', `'${id}'`)))),
        ).toMatch(/permission denied/);
        // Trigger chặn cả owner (có quyền bảng).
        expect(await asOwnerNoRls(table, stmt, [id])).toMatch(
          /LEDGER_APPEND_ONLY/,
        );
      },
    );

    it('truncate hai sổ và payments bị chặn', async () => {
      for (const t of ['student_ledger', 'revenue_ledger', 'payments'])
        expect(await fail(owner.query(`truncate ${t} cascade`))).toMatch(
          /LEDGER_APPEND_ONLY|PAYMENT_IMMUTABLE/,
        );
    });

    it('payments: không xóa, không sửa tiền/ngày/người ghi; hủy một lần rồi lý do và người hủy bất biến', async () => {
      const id = randomUUID();
      await payment(id, ids.inv, A.tenantId, A.userId, 100);
      expect(
        await fail(worker.query(`delete from payments where id = $1`, [id])),
      ).toMatch(/permission denied/);
      expect(
        await asOwnerNoRls('payments', `delete from payments where id = $1`, [
          id,
        ]),
      ).toMatch(/PAYMENT_IMMUTABLE/);
      for (const set of [
        'amount = 200',
        `paid_on = '2027-01-06'`,
        `method = 'bank_transfer'`,
        `note = 'sửa'`,
        `invoice_id = '${ids.inv}', recorded_by = '${B.userId}'`,
      ])
        expect(
          await fail(
            worker.query(`update payments set ${set} where id = $1`, [id]),
          ),
        ).toMatch(/PAYMENT_IMMUTABLE/);
      // voided_* phải đủ bộ (ràng buộc CHECK).
      expect(
        await fail(
          worker.query(`update payments set voided_at = now() where id = $1`, [
            id,
          ]),
        ),
      ).toMatch(/payments_void_fields_check/);
      await voidPayment(id, ids.inv, 'Ghi nhầm', A.userId);
      expect(
        await fail(
          worker.query(
            `update payments set void_reason = 'Đổi' where id = $1`,
            [id],
          ),
        ),
      ).toMatch(/PAYMENT_IMMUTABLE/);
      expect(
        await fail(
          worker.query(
            `update payments set voided_at = null, void_reason = null, voided_by = null where id = $1`,
            [id],
          ),
        ),
      ).toMatch(/PAYMENT_IMMUTABLE/);
      expect(
        await fail(
          payment(randomUUID(), ids.inv, A.tenantId, A.userId, 5).then(() =>
            worker.query(
              `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name, voided_at, void_reason, voided_by, voided_by_name)
               values ($1, $2, $3, 5, 'cash', '2027-01-05', $4, 'x', now(), 'x', $4, 'x')`,
              [randomUUID(), A.tenantId, ids.inv, A.userId],
            ),
          ),
        ),
      ).toMatch(/PAYMENT_IMMUTABLE/);
    });

    it('ràng buộc: amount > 0, phương thức, ghi chú ≤ 300, sổ chỉ một vế, dấu của sổ doanh thu', async () => {
      const bad = [
        () => payment(randomUUID(), ids.inv, A.tenantId, A.userId, 0),
        () => payment(randomUUID(), ids.inv, A.tenantId, A.userId, -5),
        () =>
          worker.query(
            `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name) values ($1, $2, $3, 5, 'card', '2027-01-05', $4, 'x')`,
            [randomUUID(), A.tenantId, ids.inv, A.userId],
          ),
        () =>
          worker.query(
            `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, note, recorded_by, recorded_by_name) values ($1, $2, $3, 5, 'cash', '2027-01-05', $5, $4, 'x')`,
            [randomUUID(), A.tenantId, ids.inv, A.userId, 'x'.repeat(301)],
          ),
        () =>
          worker.query(
            `insert into student_ledger (id, tenant_id, student_id, kind, debit, credit, description) values ($1, $2, $3, 'prev_adjustment', 5, 5, 'x')`,
            [randomUUID(), A.tenantId, ids.stuX],
          ),
        () =>
          worker.query(
            `insert into student_ledger (id, tenant_id, student_id, kind, description) values ($1, $2, $3, 'prev_adjustment', 'x')`,
            [randomUUID(), A.tenantId, ids.stuX],
          ),
        () =>
          worker.query(
            `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year) values ($1, $2, $3, 'reversal', 5, '2027-01-05', 2027)`,
            [randomUUID(), A.tenantId, ids.pay],
          ),
        () =>
          worker.query(
            `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year) values ($1, $2, $3, 'payment', 5, '2027-01-05', 2026)`,
            [randomUUID(), A.tenantId, revPay],
          ),
      ];
      for (const run of bad)
        expect(await fail(run())).toMatch(/violates|check|LEDGER_INVALID/);
      // Mỗi thanh toán chỉ một dòng thu.
      expect(
        await fail(
          worker.query(
            `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year) values ($1, $2, $3, 'payment', 700, '2027-01-05', 2027)`,
            [randomUUID(), A.tenantId, revPay],
          ),
        ),
      ).toMatch(/revenue_ledger_payment_kind_uq/);
    });
  });

  describe('trigger bất biến hóa đơn sau khi có thanh toán (0026 thay 0024)', () => {
    const mk = async (total = 1_000_000) => {
      const id = randomUUID();
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
        [id, A.tenantId, ids.period, ids.stuY, total],
      );
      await issue(
        id,
        `TH-${id
          .replace(/[^0-9A-HJKMNP-TV-Z]/gi, '')
          .slice(0, 6)
          .toUpperCase()
          .padEnd(6, '7')}`,
      );
      return id;
    };
    const set = (id: string, status: string, paid: number) =>
      worker.query(
        `update invoices set status = $2, paid_amount = $3 where id = $1`,
        [id, status, paid],
      );

    it('cho đổi trạng thái và paid_amount theo thu/hủy; vẫn chặn đổi tổng tiền và snapshot', async () => {
      const id = await mk();
      const [p1, p2, p3] = [randomUUID(), randomUUID(), randomUUID()];
      const status = async () =>
        (await q(`select status from invoices where id = $1`, [id]))[0].status;
      await payment(p1, id, A.tenantId, A.userId, 400_000);
      expect(await status()).toBe('partially_paid');
      await payment(p2, id, A.tenantId, A.userId, 1_100_000);
      expect(await status()).toBe('paid');
      await voidPayment(p2, id, 'a', A.userId);
      expect(await status()).toBe('partially_paid');
      await voidPayment(p1, id, 'b', A.userId);
      expect(await status()).toBe('issued');
      await payment(p3, id, A.tenantId, A.userId, 1_000_000);
      expect(await status()).toBe('paid');
      await voidPayment(p3, id, 'c', A.userId);
      expect(await status()).toBe('issued');
      for (const stmt of [
        `update invoices set total_amount = 1 where id = $1`,
        `update invoices set clamped_amount = 1 where id = $1`,
        `update invoices set qr_payload = 'x' where id = $1`,
        `update invoices set code = 'TH-ZZZZZZ' where id = $1`,
        `update invoices set payout = '{}'::jsonb where id = $1`,
      ])
        expect(await fail(worker.query(stmt, [id]))).toMatch(
          /INVOICE_IMMUTABLE/,
        );
    });

    it('trạng thái phải khớp số đã thu (CHECK); hủy hóa đơn chỉ từ issued', async () => {
      const id = await mk();
      for (const [status, paid] of [
        ['partially_paid', 0],
        ['partially_paid', 1_000_000],
        ['paid', 999_999],
        ['pending_confirmation', 1_000_000],
        ['issued', 1],
      ] as const)
        expect(await fail(set(id, status, paid))).toMatch(
          /invoices_paid_status_check/,
        );
      await payment(randomUUID(), id, A.tenantId, A.userId, 1_000_000);
      expect(
        await fail(
          worker.query(
            `update invoices set status = 'void', paid_amount = 0, voided_at = now(), void_reason = 'x' where id = $1`,
            [id],
          ),
        ),
      ).toMatch(/INVOICE_IMMUTABLE/);
    });

    it('M1: paid_amount luôn = Σ thanh toán chưa hủy, kiểm cuối giao dịch (kể cả role app)', async () => {
      const id = await mk();
      await payment(randomUUID(), id, A.tenantId, A.userId, 400_000);
      // Sửa tay paid_amount lệch (vẫn qua CHECK trạng thái) → lỗi khi commit.
      expect(
        await fail(
          asUser(
            A.userId,
            sql`update invoices set paid_amount = 500000 where id = ${id}`,
          ),
        ),
      ).toMatch(/INVOICE_PAID_MISMATCH/);
      // Đổi trạng thái mà bỏ qua số tiền cũng không được.
      expect(
        await fail(
          asUser(
            A.userId,
            sql`update invoices set status = 'pending_confirmation', paid_amount = 300000 where id = ${id}`,
          ),
        ),
      ).toMatch(/INVOICE_PAID_MISMATCH/);
      // Thêm payment mà không cập nhật hóa đơn.
      expect(
        await fail(
          asUser(
            A.userId,
            sql`insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name)
              values (${randomUUID()}, ${A.tenantId}, ${id}, 1000, 'cash', '2027-01-05', ${A.userId}, 'x')`,
          ),
        ),
      ).toMatch(/INVOICE_PAID_MISMATCH/);
      // Hủy payment mà không cập nhật hóa đơn.
      const p = randomUUID();
      await payment(p, id, A.tenantId, A.userId, 100_000);
      expect(
        await fail(
          asUser(
            A.userId,
            sql`update payments set voided_at = now(), void_reason = 'x', voided_by = ${A.userId}, voided_by_name = 'x' where id = ${p}`,
          ),
        ),
      ).toMatch(/INVOICE_PAID_MISMATCH/);
      expect(
        (
          await q(`select paid_amount::text from invoices where id = $1`, [id])
        )[0].paid_amount,
      ).toBe('500000');
    });
  });

  describe('M2/S4/S5: sổ không bịa được, chỉ chủ tenant ghi, ảnh chụp tên', () => {
    let teacher: string;
    let inv: string;
    const pay1 = randomUUID();
    beforeAll(async () => {
      teacher = await seedMember(worker, A.tenantId, 'teacher');
      inv = randomUUID();
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 1000000)`,
        [inv, A.tenantId, ids.period, ids.stuY],
      );
      await issue(inv, 'TH-M2M2M2');
      await payment(pay1, inv, A.tenantId, A.userId, 400_000);
    });
    const rev = (
      payment: string,
      kind: string,
      amount: number,
      date = '2027-01-05',
      tenant = A.tenantId,
    ) =>
      sql`insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
        values (${randomUUID()}, ${tenant}, ${payment}, ${kind}, ${amount}, ${date}, ${Number(date.slice(0, 4))})`;
    const stu = (
      kind: string,
      debit: number,
      credit: number,
      payment: string | null = pay1,
      invoice: string | null = inv,
    ) =>
      sql`insert into student_ledger (id, tenant_id, student_id, invoice_id, payment_id, kind, debit, credit, description)
        values (${randomUUID()}, ${A.tenantId}, ${ids.stuY}, ${invoice}, ${payment}, ${kind}, ${debit}, ${credit}, 'x')`;

    it('revenue_ledger: dòng bịa bằng role app → lỗi', async () => {
      for (const q2 of [
        rev(pay1, 'payment', 1), // sai số tiền (đã có dòng thu hoặc lệch tiền)
        rev(pay1, 'payment', 400_000, '2027-01-06'), // sai ngày
        rev(pay1, 'reversal', -400_000), // đảo khi chưa hủy
        rev(ids.payB, 'payment', 500_000), // thanh toán tenant khác
      ])
        expect(await fail(asUser(A.userId, q2))).toMatch(
          /LEDGER_INVALID|violates/,
        );
    });

    it('student_ledger: kind của thanh toán phải có payment/invoice khớp, đúng vế, ≤ số tiền', async () => {
      for (const q2 of [
        stu('overpayment', 0, 100, null, inv), // thiếu payment_id
        stu('overpayment', 0, 100, pay1, null), // thiếu invoice_id
        stu('overpayment', 0, 400_001), // vượt số tiền thanh toán
        stu('overpayment', 100, 0), // sai vế
        stu('payment_void', 100, 0), // thanh toán chưa hủy
        stu('overpayment', 0, 100, pay1, ids.inv), // hóa đơn khác của payment
        stu('overpayment', 0, 100, ids.payB, inv), // payment tenant khác
      ])
        expect(await fail(asUser(A.userId, q2))).toMatch(
          /LEDGER_INVALID|violates/,
        );
      // Dòng hợp lệ vẫn vào được.
    });

    it('S4: giáo viên thường đọc được payments nhưng không ghi payments hay hai sổ; chỉ chủ tenant ghi', async () => {
      expect(
        await asUser(teacher, sql`select 1 from payments where id = ${pay1}`),
      ).toHaveLength(1);
      await expectInsertRejected(
        tx,
        teacher,
        sql`insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name)
          values (${randomUUID()}, ${A.tenantId}, ${inv}, 1000, 'cash', '2027-01-05', ${teacher}, 'x')`,
      );
      expect(
        await asUser(
          teacher,
          sql`update payments set voided_at = null where id = ${pay1} returning id`,
        ),
      ).toHaveLength(0);
      await expectInsertRejected(
        tx,
        teacher,
        sql`insert into student_ledger (id, tenant_id, student_id, kind, debit, description)
          values (${randomUUID()}, ${A.tenantId}, ${ids.stuY}, 'prev_adjustment', 100, 'x')`,
      );
      await expectInsertRejected(
        tx,
        teacher,
        rev(pay1, 'payment', 400_000),
        /row-level security/,
      );
    });

    it('S5: tên người ghi/hủy là ảnh chụp bất biến, không đổi theo tài khoản', async () => {
      await q(`update users set display_name = 'Tên mới' where id = $1`, [
        A.userId,
      ]);
      expect(
        (
          await q(`select recorded_by_name from payments where id = $1`, [pay1])
        )[0].recorded_by_name,
      ).toBe('Cô Lan');
      expect(
        await fail(
          worker.query(
            `update payments set recorded_by_name = 'Khác' where id = $1`,
            [pay1],
          ),
        ),
      ).toMatch(/PAYMENT_IMMUTABLE/);
      const p = randomUUID();
      await payment(p, inv, A.tenantId, A.userId, 10_000);
      await voidPayment(p, inv, 'x', A.userId);
      expect(
        await fail(
          worker.query(
            `update payments set voided_by_name = 'Khác' where id = $1`,
            [p],
          ),
        ),
      ).toMatch(/PAYMENT_IMMUTABLE/);
    });
  });

  describe('vòng 3: sổ trả thừa, đối soát doanh thu, policy theo người thao tác', () => {
    let inv: string;
    const big = randomUUID();
    beforeAll(async () => {
      inv = randomUUID();
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 1000000)`,
        [inv, A.tenantId, ids.period, ids.stuY],
      );
      await issue(inv, 'TH-R3R3R3');
      await payment(big, inv, A.tenantId, A.userId, 1_300_000); // thừa 300k
    });
    const stu = (kind: string, debit: number, credit: number, pay = big) =>
      sql`insert into student_ledger (id, tenant_id, student_id, invoice_id, payment_id, kind, debit, credit, description)
        values (${randomUUID()}, ${A.tenantId}, ${ids.stuY}, ${inv}, ${pay}, ${kind}, ${debit}, ${credit}, 'x')`;

    it('trả thừa: không vượt phần vượt thật, mỗi thanh toán một dòng; đảo ≤ phần còn lại và mỗi thanh toán một dòng', async () => {
      expect(
        await fail(asUser(A.userId, stu('overpayment', 0, 300_001))),
      ).toMatch(/LEDGER_INVALID/);
      await asUser(A.userId, stu('overpayment', 0, 200_000));
      // Dòng thứ hai cho cùng thanh toán → unique; dòng khác kind khác payment cũng không vượt tổng 300k.
      expect(
        await fail(asUser(A.userId, stu('overpayment', 0, 50_000))),
      ).toMatch(/student_ledger_payment_kind_uq/);
      const small = randomUUID();
      // Thanh toán nhỏ ghi thêm khi hóa đơn đã thừa: thêm 100k nữa nhưng net đã 200k → tối đa 100k theo phần vượt thật (400k)
      await payment(small, inv, A.tenantId, A.userId, 100_000);
      expect(
        await fail(asUser(A.userId, stu('overpayment', 0, 200_001, small))),
      ).toMatch(/LEDGER_INVALID/);
      await asUser(A.userId, stu('overpayment', 0, 100_000, small));
      // Đảo: cần thanh toán đã hủy.
      expect(
        await fail(asUser(A.userId, stu('payment_void', 1000, 0, small))),
      ).toMatch(/LEDGER_INVALID/);
      await voidPayment(small, inv, 'x', A.userId);
      expect(
        await fail(asUser(A.userId, stu('payment_void', 100_001, 0, small))),
      ).toMatch(/LEDGER_INVALID/);
      await asUser(A.userId, stu('payment_void', 100_000, 0, small));
      expect(
        await fail(asUser(A.userId, stu('payment_void', 1, 0, small))),
      ).toMatch(/student_ledger_payment_kind_uq/);
      // Đảo vượt số dư trả thừa còn lại của hóa đơn (net = 200k) dù ≤ payment.amount.
      await voidPayment(big, inv, 'y', A.userId);
      expect(
        await fail(asUser(A.userId, stu('payment_void', 200_001, 0, big))),
      ).toMatch(/LEDGER_INVALID/);
      await asUser(A.userId, stu('payment_void', 200_000, 0, big));
    });

    it('đổi status mà giữ paid_amount sai với payments vẫn bị chặn (CHECK), nên trigger hóa đơn chỉ cần theo paid_amount', async () => {
      const id = randomUUID();
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 1000000)`,
        [id, A.tenantId, ids.period, ids.stuY],
      );
      await issue(id, 'TH-S3S3S3');
      await payment(randomUUID(), id, A.tenantId, A.userId, 400_000);
      for (const status of ['paid', 'issued', 'pending_confirmation'])
        if (status !== 'pending_confirmation')
          expect(
            await fail(
              asUser(
                A.userId,
                sql`update invoices set status = ${status} where id = ${id}`,
              ),
            ),
          ).toMatch(/invoices_paid_status_check/);
      // pending_confirmation giữ paid_amount đúng (400k) là hợp lệ.
      await asUser(
        A.userId,
        sql`update invoices set status = 'pending_confirmation' where id = ${id}`,
      );
    });

    it('mỗi thanh toán chưa hủy đúng một dòng thu, đã hủy thêm đúng một dòng đảo (cuối giao dịch)', async () => {
      const p = randomUUID();
      const bare = () =>
        inTx(async (c) => {
          await c.query(
            `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name)
             values ($1, $2, $3, 10, 'cash', '2027-01-05', $4, 'x')`,
            [p, A.tenantId, inv, A.userId],
          );
          await sync(c, inv);
        });
      expect(await fail(bare())).toMatch(/PAYMENT_LEDGER_MISMATCH/);
      await payment(p, inv, A.tenantId, A.userId, 10);
      // Hủy mà thiếu dòng đảo.
      expect(
        await fail(
          inTx(async (c) => {
            await c.query(
              `update payments set voided_at = now(), void_reason = 'x', voided_by = $2, voided_by_name = 'x' where id = $1`,
              [p, A.userId],
            );
            await sync(c, inv);
          }),
        ),
      ).toMatch(/PAYMENT_LEDGER_MISMATCH/);
    });

    it('policy: chủ tenant chỉ ghi payments với recorded_by/voided_by là chính mình', async () => {
      const mk = (by: string) =>
        sql`insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name)
          values (${randomUUID()}, ${A.tenantId}, ${inv}, 1000, 'cash', '2027-01-05', ${by}, 'x')`;
      // recorded_by giả danh người khác (user tồn tại) → RLS chặn trước các kiểm tra khác.
      await expectInsertRejected(tx, A.userId, mk(parentX));
      const p = randomUUID();
      await payment(p, inv, A.tenantId, A.userId, 1000);
      expect(
        await fail(
          asUser(
            A.userId,
            sql`update payments set voided_at = now(), void_reason = 'x', voided_by = ${parentX}, voided_by_name = 'x' where id = ${p}`,
          ),
        ),
      ).toMatch(/row-level security/);
    });
  });

  describe('nâng cấp từ 0025 trên dữ liệu có sẵn', () => {
    it('migration 0026 chạy được khi đã có hóa đơn nháp, đã phát hành và đã hủy; paid_amount = 0, ghi thanh toán được', async () => {
      const before = migrationsBefore0026();
      const old25 = await startTestDb(before);
      try {
        const w = new pg.Pool({
          connectionString: old25.url('teachhub_worker'),
        });
        const s = await seedTenant(w);
        const stu = randomUUID();
        const per = randomUUID();
        await w.query(
          `insert into students (id, tenant_id, full_name) values ($1, $2, 'HV')`,
          [stu, s.tenantId],
        );
        await w.query(
          `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, '2026-12-01', '2026-12-31', '2027-01-10')`,
          [per, s.tenantId],
        );
        const invs = {
          draft: randomUUID(),
          issued: randomUUID(),
          void: randomUUID(),
        };
        for (const [k, id] of Object.entries(invs)) {
          const p2 = randomUUID();
          await w.query(
            `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, '2026-12-31', '2027-01-10')`,
            [
              p2,
              s.tenantId,
              k === 'draft'
                ? '2027-01-01'
                : k === 'issued'
                  ? '2027-02-01'
                  : '2027-03-01',
            ],
          );
          await w.query(
            `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 700000)`,
            [id, s.tenantId, p2, stu],
          );
          if (k !== 'draft')
            await w.query(
              `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = 'q', payout = '{"a":1}'::jsonb, issued_at = now() where id = $1`,
              [
                id,
                k === 'issued' ? 'TH-AAAAAA' : 'TH-BBBBBB',
                k === 'issued' ? 'TH AAAAAA' : 'TH BBBBBB',
              ],
            );
          if (k === 'void')
            await w.query(
              `update invoices set status = 'void', voided_at = now(), void_reason = 'x' where id = $1`,
              [id],
            );
        }
        await migrateTestDb(old25);
        const rows = (
          await w.query(
            `select status, paid_amount from invoices order by status`,
          )
        ).rows;
        expect(rows).toEqual([
          { status: 'draft', paid_amount: '0' },
          { status: 'issued', paid_amount: '0' },
          { status: 'void', paid_amount: '0' },
        ]);
        await w.query('begin');
        await w.query(
          `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, recorded_by_name) values ($1, $2, $3, 100, 'cash', '2027-02-05', $4, 'x')`,
          [randomUUID(), s.tenantId, invs.issued, s.userId],
        );
        await w.query(
          `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
           select gen_random_uuid(), tenant_id, id, 'payment', 100, paid_on, 2027 from payments where invoice_id = $1`,
          [invs.issued],
        );
        await w.query(
          `update invoices set status = 'partially_paid', paid_amount = 100 where id = $1`,
          [invs.issued],
        );
        await w.query('commit');
        await w.end();
      } finally {
        await old25.container.stop();
      }
    }, 240_000);

    it('M3: có hóa đơn paid từ trước 0026 (không có payment) → migration dừng với lỗi rõ, không đoán số tiền', async () => {
      const old25 = await startTestDb(migrationsBefore0026());
      try {
        const w = new pg.Pool({
          connectionString: old25.url('teachhub_worker'),
        });
        const s = await seedTenant(w);
        const stu = randomUUID();
        const per = randomUUID();
        const inv = randomUUID();
        await w.query(
          `insert into students (id, tenant_id, full_name) values ($1, $2, 'HV')`,
          [stu, s.tenantId],
        );
        await w.query(
          `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, '2026-12-01', '2026-12-31', '2027-01-10')`,
          [per, s.tenantId],
        );
        await w.query(
          `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 700000)`,
          [inv, s.tenantId, per, stu],
        );
        await w.query(
          `update invoices set status = 'issued', code = 'TH-AAAAAA', transfer_note = 'TH AAAAAA', qr_payload = 'q', payout = '{"a":1}'::jsonb, issued_at = now() where id = $1`,
          [inv],
        );
        await w.query(`update invoices set status = 'paid' where id = $1`, [
          inv,
        ]);
        // Drizzle bọc lỗi pg thành "Failed query"; thông điệp thật nằm ở `cause`.
        const err = (await migrateTestDb(old25).catch(
          (x: unknown) => x,
        )) as Error & { cause?: Error };
        expect(err.cause?.message ?? err.message).toMatch(
          /Migration 0026: có 1 hóa đơn/,
        );
        // Giao dịch migration rollback: chưa có bảng payments.
        expect(
          (await w.query(`select to_regclass('public.payments') as t`)).rows[0]
            .t,
        ).toBeNull();
        await w.end();
      } finally {
        await old25.container.stop();
      }
    }, 240_000);
  });
});
