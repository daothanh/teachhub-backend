import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { TxService } from '@teachhub/db';
import { startTestDb, type TestDb } from './containers.js';
import {
  expectInsertRejected,
  expectRowIsolated,
} from './support/isolation.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

// S5-BE-01 + S5-BE-04: học phí lớp, payout_accounts, kỳ thu, hóa đơn: RLS chéo tenant, phụ huynh, trigger bất biến, unique.
describe('billing schema: RLS, ràng buộc, bất biến hóa đơn', () => {
  let db: TestDb;
  let worker: pg.Pool;
  let appPool: pg.Pool;
  let tx: TxService;
  let A: SeededTenant;
  let B: SeededTenant;
  let parentX: string;
  let parentY: string;
  const ids = {
    classA: randomUUID(),
    stuX: randomUUID(),
    stuY: randomUUID(),
    periodA: randomUUID(),
    periodB: randomUUID(),
    draftX: randomUUID(),
    draftY: randomUUID(),
    issuedX: randomUUID(),
    payoutA: randomUUID(),
    payoutB: randomUUID(),
  };

  const asA = (q: ReturnType<typeof sql>) =>
    tx.run({ userId: A.userId }, (t) => t.execute(q));
  const asUser = (userId: string, q: ReturnType<typeof sql>) =>
    tx.run({ userId }, async (t) => (await t.execute(q)).rows);
  const invoice = (id: string, student: string, period = ids.periodA) =>
    sql`insert into invoices (id, tenant_id, period_id, student_id, total_amount)
      values (${id}, ${A.tenantId}, ${period}, ${student}, 500000)`;
  const line = (
    invoiceId: string,
    pos: number,
    amount = 500000,
    kind = 'monthly',
  ) => sql`insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount)
    values (${randomUUID()}, ${A.tenantId}, ${invoiceId}, ${pos}, ${kind}, 'Học phí', ${amount})`;
  const issue = (id: string, code = 'TH-25K7Q9') => sql`update invoices set
    status = 'issued', code = ${code}, transfer_note = ${code.replace('-', ' ')}, qr_payload = '000201',
    payout = ${JSON.stringify({ bankBin: '970436', accountNo: '0123456789', accountName: 'NGUYEN VAN A' })}::jsonb,
    issued_at = now() where id = ${id}`;

  beforeAll(async () => {
    db = await startTestDb();
    worker = new pg.Pool({ connectionString: db.url('teachhub_worker') });
    appPool = new pg.Pool({ connectionString: db.url('teachhub_app') });
    tx = new TxService(drizzle(appPool));
    A = await seedTenant(worker);
    B = await seedTenant(worker);
    parentX = randomUUID();
    parentY = randomUUID();
    for (const p of [parentX, parentY])
      await worker.query(`insert into users (id, email) values ($1, $2)`, [
        p,
        `${p}@example.com`,
      ]);
    await asA(sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
      values (${ids.classA}, ${A.tenantId}, ${A.branchId}, 'Toán', 'Toán', 9, 'online', '2026-12-14')`);
    for (const [id, user] of [
      [ids.stuX, parentX],
      [ids.stuY, parentY],
    ] as const) {
      await asA(
        sql`insert into students (id, tenant_id, full_name) values (${id}, ${A.tenantId}, 'Học viên')`,
      );
      await worker.query(
        `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'Phụ huynh', $4)`,
        [randomUUID(), A.tenantId, id, user],
      );
    }
    await asA(sql`insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
      values (${ids.periodA}, ${A.tenantId}, '2026-12-01', '2026-12-31', '2027-01-10')`);
    await tx.run({ userId: B.userId }, (t) =>
      t.execute(sql`insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
      values (${ids.periodB}, ${B.tenantId}, '2026-12-01', '2026-12-31', '2027-01-10')`),
    );
    await asA(invoice(ids.draftX, ids.stuX));
    await asA(invoice(ids.draftY, ids.stuY));
    await asA(line(ids.draftX, 1));
    await asA(sql`insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary)
      values (${ids.payoutA}, ${A.tenantId}, '970436', '0123456789', 'NGUYEN VAN A', true)`);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), appPool?.end()]);
    await db?.container.stop();
  });

  it('0035: nhân sự khác chủ (teacher) chỉ đọc bảng tiền, không ghi được', async () => {
    const teacher = await seedMember(worker, A.tenantId, 'teacher');
    const n = async (q: ReturnType<typeof sql>) =>
      tx.run({ userId: teacher }, async (t) => (await t.execute(q)).rowCount);
    for (const [table, id] of [
      ['billing_periods', ids.periodA],
      ['invoices', ids.draftY],
      ['payout_accounts', ids.payoutA],
    ] as const)
      expect(
        await n(sql`select 1 from ${sql.identifier(table)} where id = ${id}`),
        table,
      ).toBe(1);
    expect(
      await n(
        sql`select 1 from invoice_lines where invoice_id = ${ids.draftX}`,
      ),
    ).toBe(1);
    await expectInsertRejected(
      tx,
      teacher,
      sql`insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
        values (${randomUUID()}, ${A.tenantId}, '2027-03-01', '2027-03-31', '2027-04-10')`,
    );
    await expectInsertRejected(tx, teacher, invoice(randomUUID(), ids.stuX));
    await expectInsertRejected(tx, teacher, line(ids.draftX, 9));
    await expectInsertRejected(
      tx,
      teacher,
      sql`insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name)
        values (${randomUUID()}, ${A.tenantId}, '970436', '1111111111', 'GV')`,
    );
    expect(
      await n(
        sql`update invoices set total_amount = total_amount where id = ${ids.draftY}`,
      ),
    ).toBe(0);
    expect(
      await n(
        sql`update billing_periods set due_date = due_date where id = ${ids.periodA}`,
      ),
    ).toBe(0);
    expect(
      await n(sql`delete from payout_accounts where id = ${ids.payoutA}`),
    ).toBe(0);
    expect(
      await n(sql`delete from invoice_lines where invoice_id = ${ids.draftX}`),
    ).toBe(0);
  });

  it('AC-1: lớp cũ không học phí; CHECK cặp fee_type/fee_amount, trần và enum', async () => {
    const { rows } = await worker.query(
      `select fee_type, fee_amount, fee_rules from classes where id = $1`,
      [ids.classA],
    );
    expect(rows[0]).toEqual({
      fee_type: null,
      fee_amount: null,
      fee_rules: null,
    });
    const set = (v: string) =>
      sql.raw(`update classes set ${v} where id = '${ids.classA}'`);
    await expectInsertRejected(
      tx,
      A.userId,
      set(`fee_type = 'monthly'`),
      /classes_fee_pair_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      set(`fee_amount = 100000`),
      /classes_fee_pair_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      set(`fee_type = 'monthly', fee_amount = 0`),
      /classes_fee_amount_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      set(`fee_type = 'monthly', fee_amount = 100000000001`),
      /classes_fee_amount_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      set(`fee_type = 'weekly', fee_amount = 1`),
      /classes_fee_type_check/,
    );
    await asA(
      set(
        `fee_type = 'course', fee_amount = 100000000000, fee_rules = '{"installments":3}'`,
      ),
    );
    await asA(set(`fee_type = null, fee_amount = null, fee_rules = null`));
  });

  it('AC-1: enrollments.fee_override nhận jsonb', async () => {
    const enr = randomUUID();
    await asA(sql`insert into enrollments (id, tenant_id, class_id, student_id, joined_on, fee_override)
      values (${enr}, ${A.tenantId}, ${ids.classA}, ${ids.stuX}, '2026-12-14', '{"feeAmount":120000}')`);
    const rows = await asA(
      sql`select fee_override from enrollments where id = ${enr}`,
    );
    expect(rows.rows[0]).toEqual({ fee_override: { feeAmount: 120000 } });
  });

  it('AC-2/5: RLS chéo tenant cho payout_accounts, billing_periods, invoices, invoice_lines', async () => {
    const lineId = (
      await worker.query(`select id from invoice_lines where invoice_id = $1`, [
        ids.draftX,
      ])
    ).rows[0].id as string;
    for (const [table, rowId, intruder] of [
      ['payout_accounts', ids.payoutA, B.userId],
      ['billing_periods', ids.periodA, B.userId],
      ['invoices', ids.draftX, B.userId],
      ['invoice_lines', lineId, B.userId],
    ] as const)
      await expectRowIsolated(tx, { table, rowId, owner: A.userId, intruder });
  });

  it('AC-5: B không ghi được hóa đơn/tài khoản gắn tenant A', async () => {
    await expectInsertRejected(tx, B.userId, invoice(randomUUID(), ids.stuX));
    await expectInsertRejected(
      tx,
      B.userId,
      sql`insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name)
        values (${randomUUID()}, ${A.tenantId}, '970436', '0123456789', 'X')`,
    );
  });

  it('AC-2: CHECK bin/số tài khoản/tên; unique một tài khoản chính mỗi tenant', async () => {
    const ins = (bin: string, no: string, name: string, primary: boolean) =>
      sql`insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary)
        values (${randomUUID()}, ${A.tenantId}, ${bin}, ${no}, ${name}, ${primary})`;
    await expectInsertRejected(
      tx,
      A.userId,
      ins('97043', '0123456789', 'A', false),
      /bank_bin_check|value too long/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      ins('97043a', '0123456789', 'A', false),
      /bank_bin_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      ins('970436', '12345', 'A', false),
      /account_no_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      ins('970436', '12345678901234567890', 'A', false),
      /account_no_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      ins('970436', '123456', 'x'.repeat(51), false),
      /account_name_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      ins('970436', '123456', 'B', true),
      /payout_accounts_primary_uq/,
    );
    await asA(ins('970436', '123456', 'Phụ', false));
    await tx.run({ userId: B.userId }, (t) =>
      t.execute(sql`insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary)
        values (${ids.payoutB}, ${B.tenantId}, '970436', '0123456789', 'B', true)`),
    );
  });

  it('AC-3: unique kỳ theo tenant; unique bản nháp (tenant, kỳ, học viên) chạy job hai lần không trùng', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
        values (${randomUUID()}, ${A.tenantId}, '2026-12-01', '2026-12-31', '2027-01-10')`,
      /billing_periods_tenant_month_uq/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
        values (${randomUUID()}, ${A.tenantId}, '2027-01-15', '2027-01-31', '2027-02-10')`,
      /billing_periods_month_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      invoice(randomUUID(), ids.stuX),
      /invoices_draft_uq/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into invoices (id, tenant_id, period_id, student_id) values (${randomUUID()}, ${A.tenantId}, ${ids.periodA}, ${randomUUID()})`,
      /invoices_tenant_student_fk/,
    );
  });

  it('AC-3: FK kép chặn hóa đơn trỏ kỳ của tenant khác; CHECK dòng', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      invoice(randomUUID(), ids.stuX, ids.periodB),
      /invoices_tenant_period_fk/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount, charged)
        values (${randomUUID()}, ${A.tenantId}, ${ids.draftX}, 2, 'session', 'Buổi', 0, false)`,
      /invoice_lines_not_charged_reason_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount, charged, not_charged_reason)
        values (${randomUUID()}, ${A.tenantId}, ${ids.draftX}, 2, 'session', 'Buổi', 1000, false, 'cancelled')`,
      /invoice_lines_charged_amount_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      line(ids.draftX, 2, 1000, 'manual_adjustment'),
      /adjustment_reason_check/,
    );
    await asA(line(ids.draftX, 2, -50000, 'discount'));
  });

  it('AC-4: draft sửa được dòng; phát hành xong sửa tiền/snapshot/dòng đều lỗi INVOICE_IMMUTABLE', async () => {
    await asA(
      sql`update invoices set total_amount = 450000 where id = ${ids.draftX}`,
    );
    await asA(issue(ids.draftX));
    const bad = (q: ReturnType<typeof sql>) =>
      expectInsertRejected(tx, A.userId, q, /INVOICE_IMMUTABLE/);
    await bad(
      sql`update invoices set total_amount = 1 where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set clamped_amount = 1 where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set qr_payload = 'x' where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set transfer_note = 'TH 111111' where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set payout = '{}'::jsonb where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set code = 'TH-ZZZZZZ' where id = ${ids.draftX}`,
    );
    await bad(sql`delete from invoices where id = ${ids.draftX}`);
    await bad(line(ids.draftX, 9));
    await bad(
      sql`update invoice_lines set amount = 1 where invoice_id = ${ids.draftX}`,
    );
    await bad(sql`delete from invoice_lines where invoice_id = ${ids.draftX}`);
    const { rows } = await worker.query(
      `select total_amount from invoices where id = $1`,
      [ids.draftX],
    );
    expect(Number(rows[0].total_amount)).toBe(450000);
  });

  it('AC-4: chỉ chuyển trạng thái hợp lệ; void cần lý do; không tạo hóa đơn ngoài draft', async () => {
    await expectInsertRejected(
      tx,
      A.userId,
      sql`update invoices set status = 'draft' where id = ${ids.draftX}`,
      /INVOICE_IMMUTABLE|invoices_issue_fields_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`update invoices set status = 'void' where id = ${ids.draftX}`,
      /invoices_void_fields_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`update invoices set status = 'void' where id = ${ids.draftY}`,
      /INVOICE_IMMUTABLE/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into invoices (id, tenant_id, period_id, student_id, status) values (${randomUUID()}, ${A.tenantId}, ${ids.periodA}, ${ids.stuX}, 'paid')`,
      /INVOICE_IMMUTABLE/,
    );
    await asA(
      sql`update invoices set status = 'void', void_reason = 'Nhập sai', voided_at = now() where id = ${ids.draftX}`,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`update invoices set status = 'issued' where id = ${ids.draftX}`,
      /INVOICE_IMMUTABLE/,
    );
    // Sau khi hủy, bản nháp thay thế cho cùng học viên được phép (unique chỉ áp cho draft).
    const repl = randomUUID();
    await asA(sql`insert into invoices (id, tenant_id, period_id, student_id, replaces_invoice_id)
      values (${repl}, ${A.tenantId}, ${ids.periodA}, ${ids.stuX}, ${ids.draftX})`);
    await asA(
      sql`update invoices set replacement_invoice_id = ${repl} where id = ${ids.draftX}`,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`insert into invoices (id, tenant_id, period_id, student_id, replaces_invoice_id)
        values (${randomUUID()}, ${A.tenantId}, ${ids.periodA}, ${ids.stuX}, ${ids.draftX})`,
      /invoices_replaces_uq|invoices_draft_uq/,
    );
  });

  it('AC-4: unique mã hóa đơn theo tenant', async () => {
    await asA(issue(ids.draftY, 'TH-ABCDEF'));
    const other = randomUUID();
    await worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Z')`,
      [other, A.tenantId],
    );
    await asA(invoice(other, other));
    await expectInsertRejected(
      tx,
      A.userId,
      issue(other, 'TH-ABCDEF'),
      /invoices_tenant_code_uq/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      issue(other, 'TH-ILOU00'),
      /invoices_code_check/,
    );
  });

  it('AC-5: phụ huynh chỉ đọc hóa đơn, dòng và kỳ không phải nháp của con mình; không ghi', async () => {
    const idsOf = async (user: string) =>
      (await asUser(user, sql`select id from invoices`)).map((r) => r.id);
    // X: chỉ hóa đơn hủy (repl là nháp, draftX đã void); Y: hóa đơn đã phát hành của con Y.
    expect(await idsOf(parentX)).toEqual([ids.draftX]);
    expect(await idsOf(parentY)).toEqual([ids.draftY]);
    expect(
      await asUser(parentX, sql`select 1 from invoice_lines`),
    ).toHaveLength(2);
    expect(
      await asUser(parentY, sql`select 1 from invoice_lines`),
    ).toHaveLength(0);
    expect(
      await asUser(parentY, sql`select 1 from billing_periods`),
    ).toHaveLength(1);
    expect(
      await asUser(randomUUID(), sql`select 1 from invoices`),
    ).toHaveLength(0);
    expect(
      await asUser(parentX, sql`select 1 from payout_accounts`),
    ).toHaveLength(0);
    await expectInsertRejected(tx, parentX, invoice(randomUUID(), ids.stuX));
    expect(
      await tx.run(
        { userId: parentX },
        async (t) =>
          (
            await t.execute(
              sql`update invoices set void_reason = 'x' where id = ${ids.draftX}`,
            )
          ).rowCount,
      ),
    ).toBe(0);
  });

  it('guard: hóa đơn đã hủy không đổi void_reason, voided_at; replacement_invoice_id đã gán không đổi', async () => {
    // draftX đã void và đã có replacement (test trước).
    const bad = (q: ReturnType<typeof sql>) =>
      expectInsertRejected(tx, A.userId, q, /INVOICE_IMMUTABLE/);
    await bad(
      sql`update invoices set void_reason = 'Đổi lý do' where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set voided_at = now() + interval '1 day' where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set replacement_invoice_id = ${ids.draftY} where id = ${ids.draftX}`,
    );
    await bad(
      sql`update invoices set replacement_invoice_id = null where id = ${ids.draftX}`,
    );
  });

  it('guard: pending_confirmation không chuyển thẳng sang void', async () => {
    const stu = randomUUID();
    const inv = randomUUID();
    await worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'P')`,
      [stu, A.tenantId],
    );
    await asA(invoice(inv, stu));
    await asA(issue(inv, 'TH-PEND00'));
    await asA(
      sql`update invoices set status = 'pending_confirmation' where id = ${inv}`,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      sql`update invoices set status = 'void', void_reason = 'x', voided_at = now() where id = ${inv}`,
      /INVOICE_IMMUTABLE/,
    );
  });

  it('fee_rules/fee_override: phải là object, nhỏ hơn 4KB; fee_rules null khi chưa có học phí', async () => {
    const cls = (v: string) =>
      sql.raw(`update classes set ${v} where id = '${ids.classA}'`);
    await expectInsertRejected(
      tx,
      A.userId,
      cls(`fee_rules = '{}'`),
      /classes_fee_rules_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      cls(`fee_type = 'monthly', fee_amount = 1, fee_rules = '[1]'`),
      /classes_fee_rules_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      cls(
        `fee_type = 'monthly', fee_amount = 1, fee_rules = jsonb_build_object('x', repeat('a', 5000))`,
      ),
      /classes_fee_rules_check/,
    );
    const enr = (v: string) =>
      sql.raw(`update enrollments set fee_override = ${v}`);
    await expectInsertRejected(
      tx,
      A.userId,
      enr(`'"x"'`),
      /enrollments_fee_override_check/,
    );
    await expectInsertRejected(
      tx,
      A.userId,
      enr(`jsonb_build_object('x', repeat('a', 5000))`),
      /enrollments_fee_override_check/,
    );
  });

  it('không có audit trigger của DB trên payout_accounts và invoices (số tài khoản không vào audit_logs)', async () => {
    const { rows } = await worker.query(
      `select tgrelid::regclass::text as t from pg_trigger
        where not tgisinternal and tgname like '%audit%' and tgrelid::regclass::text in ('payout_accounts','invoices','invoice_lines')`,
    );
    expect(rows).toEqual([]);
  });

  it('delete_account: tenant có payout và hóa đơn đã phát hành → thành công, payout sạch, hóa đơn còn', async () => {
    const C = await seedTenant(worker);
    const stu = randomUUID();
    const period = randomUUID();
    const inv = randomUUID();
    const sess = randomUUID();
    const cls = randomUUID();
    const asC = (q: ReturnType<typeof sql>) =>
      tx.run({ userId: C.userId }, (t) => t.execute(q));
    await asC(
      sql`insert into students (id, tenant_id, full_name) values (${stu}, ${C.tenantId}, 'Em C')`,
    );
    await asC(sql`insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
      values (${period}, ${C.tenantId}, '2026-12-01', '2026-12-31', '2027-01-10')`);
    await asC(sql`insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary)
      values (${randomUUID()}, ${C.tenantId}, '970436', '0123456789', 'NGUYEN VAN C', true)`);
    await asC(sql`insert into invoices (id, tenant_id, period_id, student_id, total_amount)
      values (${inv}, ${C.tenantId}, ${period}, ${stu}, 100000)`);
    await asC(sql`insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, status)
      values (${cls}, ${C.tenantId}, ${C.branchId}, 'Lý', 'Lý', 9, 'online', '2026-12-14', 'archived')`);
    await asC(sql`insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at)
      values (${sess}, ${C.tenantId}, ${cls}, '2026-12-15', now(), now() + interval '90 minutes')`);
    await asC(sql`insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount, session_id)
      values (${randomUUID()}, ${C.tenantId}, ${inv}, 1, 'session', 'Buổi', 100000, ${sess})`);
    await asC(issue(inv, 'TH-DEX000'));
    // Xóa cứng buổi (luồng schedule) không vướng dòng hóa đơn đã phát hành.
    await worker.query(`delete from sessions where id = $1`, [sess]);

    const res = await tx.run(
      { userId: C.userId },
      async (t) =>
        (await t.execute(sql`select app_private.delete_account() as r`)).rows,
    );
    expect(res[0]).toEqual({ r: null });
    const left = async (q: string) =>
      Number((await worker.query(q, [C.tenantId])).rows[0].n);
    expect(
      await left(`select count(*) n from payout_accounts where tenant_id = $1`),
    ).toBe(0);
    expect(
      await left(
        `select count(*) n from invoices where tenant_id = $1 and payout is not null`,
      ),
    ).toBe(1);
    expect(
      await left(`select count(*) n from invoice_lines where tenant_id = $1`),
    ).toBe(1);
  });

  it('mọi bảng mới bật và ép RLS', async () => {
    const { rows } =
      await worker.query(`select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('payout_accounts','billing_periods','invoices','invoice_lines')`);
    expect(rows).toHaveLength(4);
    for (const r of rows)
      expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([
        r.relname,
        true,
        true,
      ]);
  });
});
