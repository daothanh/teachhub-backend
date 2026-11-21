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
import { seedTenant, type SeededTenant } from './support/seed.js';

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
  const payment = (
    id: string,
    inv: string,
    tenantId: string,
    by: string,
    amount = 500_000,
  ) =>
    q(
      `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by)
       values ($1, $2, $3, $4, 'cash', '2027-01-05', $5)`,
      [id, tenantId, inv, amount, by],
    );

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
        sql`insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by)
          values (${randomUUID()}, ${A.tenantId}, ${ids.inv}, 1000, 'cash', '2027-01-05', ${B.userId})`,
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
        sql`insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by)
          values (${randomUUID()}, ${A.tenantId}, ${ids.inv}, 1000, 'cash', '2027-01-05', ${parentX})`,
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
      const rid = randomUUID();
      await asUser(
        A.userId,
        sql`insert into student_ledger (id, tenant_id, student_id, invoice_id, payment_id, kind, credit, description)
          values (${lid}, ${A.tenantId}, ${ids.stuX}, ${ids.inv}, ${ids.pay}, 'overpayment', 100, 'x')`,
      );
      await asUser(
        A.userId,
        sql`insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
          values (${rid}, ${A.tenantId}, ${ids.pay}, 'payment', 500000, '2027-01-05', 2027)`,
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
      );
      await expectInsertRejected(
        tx,
        parentX,
        sql`insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
          values (${randomUUID()}, ${A.tenantId}, ${ids.pay}, 'reversal', -1, '2027-01-05', 2027)`,
      );
    });
  });

  describe('chỉ ghi thêm và bất biến', () => {
    let ledgerId: string;
    let revenueId: string;
    const revPay = randomUUID();
    beforeAll(async () => {
      ledgerId = randomUUID();
      revenueId = randomUUID();
      await payment(revPay, ids.inv, A.tenantId, A.userId, 700);
      await q(
        `insert into student_ledger (id, tenant_id, student_id, kind, debit, description) values ($1, $2, $3, 'prev_adjustment', 50, 'x')`,
        [ledgerId, A.tenantId, ids.stuX],
      );
      await q(
        `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year)
         values ($1, $2, $3, 'payment', 500000, '2027-01-05', 2027)`,
        [revenueId, A.tenantId, revPay],
      );
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
      await worker.query(
        `update payments set voided_at = now(), void_reason = 'Ghi nhầm', voided_by = $2 where id = $1`,
        [id, A.userId],
      );
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
              `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by, voided_at, void_reason, voided_by)
               values ($1, $2, $3, 5, 'cash', '2027-01-05', $4, now(), 'x', $4)`,
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
            `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by) values ($1, $2, $3, 5, 'card', '2027-01-05', $4)`,
            [randomUUID(), A.tenantId, ids.inv, A.userId],
          ),
        () =>
          worker.query(
            `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, note, recorded_by) values ($1, $2, $3, 5, 'cash', '2027-01-05', $5, $4)`,
            [randomUUID(), A.tenantId, ids.inv, A.userId, 'x'.repeat(301)],
          ),
        () =>
          worker.query(
            `insert into student_ledger (id, tenant_id, student_id, kind, debit, credit, description) values ($1, $2, $3, 'overpayment', 5, 5, 'x')`,
            [randomUUID(), A.tenantId, ids.stuX],
          ),
        () =>
          worker.query(
            `insert into student_ledger (id, tenant_id, student_id, kind, description) values ($1, $2, $3, 'overpayment', 'x')`,
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
        expect(await fail(run())).toMatch(/violates|check/);
      // Mỗi thanh toán chỉ một dòng thu.
      expect(
        await fail(
          worker.query(
            `insert into revenue_ledger (id, tenant_id, payment_id, kind, amount, entry_date, fiscal_year) values ($1, $2, $3, 'payment', 5, '2027-01-05', 2027)`,
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
      await set(id, 'partially_paid', 400_000);
      await set(id, 'paid', 1_500_000);
      await set(id, 'partially_paid', 900_000);
      await set(id, 'issued', 0);
      await set(id, 'paid', 1_000_000);
      await set(id, 'issued', 0);
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
        ['issued', 1],
      ] as const)
        expect(await fail(set(id, status, paid))).toMatch(
          /invoices_paid_status_check/,
        );
      await set(id, 'paid', 1_000_000);
      expect(
        await fail(
          worker.query(
            `update invoices set status = 'void', paid_amount = 0, voided_at = now(), void_reason = 'x' where id = $1`,
            [id],
          ),
        ),
      ).toMatch(/INVOICE_IMMUTABLE/);
    });
  });

  describe('nâng cấp từ 0025 trên dữ liệu có sẵn', () => {
    it('migration 0026 chạy được khi đã có hóa đơn nháp, đã phát hành và đã hủy; paid_amount = 0, ghi thanh toán được', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mig-'));
      cpSync('libs/db/migrations', dir, { recursive: true });
      const old = JSON.parse(
        readFileSync('libs/db/migrations/meta/_journal.json', 'utf8'),
      ) as { entries: { tag: string }[] };
      mkdirSync(join(dir, 'before'));
      const before = join(dir, 'before');
      cpSync(join(dir, 'meta'), join(before, 'meta'), { recursive: true });
      for (const e of old.entries.filter((x) => !x.tag.startsWith('0026')))
        cpSync(join(dir, `${e.tag}.sql`), join(before, `${e.tag}.sql`));
      writeFileSync(
        join(before, 'meta/_journal.json'),
        JSON.stringify({
          ...old,
          entries: old.entries.filter((x) => !x.tag.startsWith('0026')),
        }),
      );
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
        await w.query(
          `insert into payments (id, tenant_id, invoice_id, amount, method, paid_on, recorded_by) values ($1, $2, $3, 100, 'cash', '2027-02-05', $4)`,
          [randomUUID(), s.tenantId, invs.issued, s.userId],
        );
        await w.end();
      } finally {
        await old25.container.stop();
      }
    }, 240_000);
  });
});
