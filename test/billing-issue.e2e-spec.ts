import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { buildVietQrPayload } from '../libs/modules/billing/domain/vietqr.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S5-BE-07: phát hành hóa đơn kèm VietQR (US-7.2 AC4, US-7.3) và hủy hóa đơn. Dữ liệu dựng thẳng bằng worker (BYPASSRLS).
describe('billing: phát hành và hủy hóa đơn', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;
  let C: Who; // chưa có tài khoản nhận tiền
  let teacherToken: string;

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    who: { token: string },
    url: string,
    payload: object,
    key: string | null = randomUUID(),
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });

  /** Kỳ mới + một bản nháp cho mỗi số tiền; trả id kỳ và id hóa đơn theo thứ tự `amounts`. */
  let monthSeq = 0;
  const mkPeriod = async (who: SeededTenant, amounts: number[]) => {
    const periodId = randomUUID();
    const month = `${2030 + Math.floor(monthSeq / 12)}-${String((monthSeq++ % 12) + 1).padStart(2, '0')}-01`;
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $3, $3)`,
      [periodId, who.tenantId, month],
    );
    const invoiceIds: string[] = [];
    for (const [i, amount] of amounts.entries()) {
      const stu = randomUUID();
      const inv = randomUUID();
      await q(
        `insert into students (id, tenant_id, full_name) values ($1, $2, $3)`,
        [stu, who.tenantId, `HS ${i}`],
      );
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
        [inv, who.tenantId, periodId, stu, amount],
      );
      // Phát hành tính lại tổng từ dòng hóa đơn: hóa đơn có tiền cần một dòng gốc.
      if (amount > 0)
        await q(
          `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount) values ($1, $2, $3, 1, 'monthly', 'Học phí tháng', $4)`,
          [randomUUID(), who.tenantId, inv, amount],
        );
      invoiceIds.push(inv);
    }
    return { periodId, invoiceIds };
  };
  const invoice = async (id: string) =>
    (await q(`select * from invoices where id = $1`, [id]))[0];
  const events = async (tenantId: string, ids: string[]) =>
    (
      await q(
        `select payload from outbox_events where tenant_id = $1 and type = 'invoice_issued' and payload->>'invoiceId' = any($2)`,
        [tenantId, ids],
      )
    ).map((r) => r.payload);

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B, C] = [await mk(), await mk(), await mk()];
    teacherToken = await t.tokenFor(
      await seedMember(t.worker, A.tenantId, 'teacher'),
    );
    for (const [who, no] of [
      [A, '0011223344'],
      [B, '9988776655'],
    ] as const)
      await q(
        `insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary) values ($1, $2, '970436', $3, 'GV', true)`,
        [randomUUID(), who.tenantId, no],
      );
  }, 60_000);
  afterAll(() => t?.stop());

  it('AC-1/2/3/6/8: phát hành tất cả trong một lần, mã + nội dung CK + QR đúng, 0 đ giữ nháp, outbox + audit, kỳ đóng', async () => {
    const { periodId, invoiceIds } = await mkPeriod(A, [1_200_000, 500_000, 0]);
    const res = await call(A, `/billing-periods/${periodId}/issue`, {
      invoiceIds: null,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.issuedCount).toBe(2);
    expect(body.totalAmount).toBe(1_700_000);
    expect(body.skipped).toEqual([
      { invoiceId: invoiceIds[2], studentName: 'HS 2', reason: 'ZERO_AMOUNT' },
    ]);

    for (const [i, amount] of [1_200_000, 500_000].entries()) {
      const row = await invoice(invoiceIds[i]!);
      expect(row.status).toBe('issued');
      expect(row.code).toMatch(/^TH-[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(row.transfer_note).toBe(row.code.replace('-', ' '));
      expect(row.transfer_note.length).toBeLessThanOrEqual(25);
      expect(row.issued_at).not.toBeNull();
      expect(row.payout).toEqual({
        bankBin: '970436',
        bankName: null,
        accountNo: '0011223344',
        accountName: 'GV',
      });
      expect(row.qr_payload).toBe(
        buildVietQrPayload({
          bankBin: '970436',
          accountNo: '0011223344',
          amount,
          transferNote: row.transfer_note,
        }),
      );
      expect(
        body.invoices.find((x: { id: string }) => x.id === row.id),
      ).toMatchObject({
        code: row.code,
        transferNote: row.transfer_note,
        qrPayload: row.qr_payload,
        totalAmount: amount,
      });
    }
    const zero = await invoice(invoiceIds[2]!);
    expect(zero.status).toBe('draft');
    expect(zero.code).toBeNull();

    // Outbox cùng giao dịch: 2 sự kiện, không có cho hóa đơn 0 đ; payload không chứa tên học viên hay tài khoản.
    const ev = await events(A.tenantId, invoiceIds);
    expect(new Set(ev.map((e) => e.invoiceId))).toEqual(
      new Set([invoiceIds[0], invoiceIds[1]]),
    );
    expect(JSON.stringify(ev)).not.toMatch(/0011223344|HS /);
    // Audit phát hành, không lộ số tài khoản.
    const audits = await q(
      `select after_data from audit_logs where tenant_id = $1 and entity = 'invoice' and entity_id = any($2)`,
      [A.tenantId, invoiceIds],
    );
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('0011223344');
    expect(
      (
        await q(`select status from billing_periods where id = $1`, [periodId])
      )[0].status,
    ).toBe('closed');

    // AC-8: đã phát hành thì CSDL chặn sửa tiền; API điều chỉnh → 409.
    await expect(
      t.worker.query(`update invoices set total_amount = 1 where id = $1`, [
        invoiceIds[0],
      ]),
    ).rejects.toThrow(/INVOICE_IMMUTABLE/);
    const adj = await t.app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceIds[0]}/adjustments`,
      payload: { amount: -1000, description: 'x', adjustmentReason: 'y' },
      headers: {
        authorization: `Bearer ${A.token}`,
        'idempotency-key': randomUUID(),
      },
    });
    expect(adj.statusCode).toBe(409);
    expect(adj.json().code).toBe('INVOICE_IMMUTABLE');
  });

  it('AC-5: cùng Idempotency-Key trả lại kết quả cũ; khóa mới khi hết nháp → issuedCount 0, không thêm outbox', async () => {
    const { periodId, invoiceIds } = await mkPeriod(A, [100_000, 200_000]);
    const key = randomUUID();
    const first = await call(
      A,
      `/billing-periods/${periodId}/issue`,
      { invoiceIds: null },
      key,
    );
    const again = await call(
      A,
      `/billing-periods/${periodId}/issue`,
      { invoiceIds: null },
      key,
    );
    expect(first.json().issuedCount).toBe(2);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    const fresh = await call(A, `/billing-periods/${periodId}/issue`, {
      invoiceIds: null,
    });
    expect(fresh.json()).toMatchObject({
      issuedCount: 0,
      skipped: [],
      totalAmount: 0,
    });
    expect(await events(A.tenantId, invoiceIds)).toHaveLength(2);
  });

  it('Security: phản hồi idempotency của issue lưu mã hóa, không chứa số tài khoản dạng rõ; phát lại vẫn đúng', async () => {
    const { periodId } = await mkPeriod(A, [123_000]);
    const key = randomUUID();
    const first = await call(
      A,
      `/billing-periods/${periodId}/issue`,
      { invoiceIds: null },
      key,
    );
    const again = await call(
      A,
      `/billing-periods/${periodId}/issue`,
      { invoiceIds: null },
      key,
    );
    expect(again.json()).toEqual(first.json());
    expect(first.json().invoices[0].qrPayload).toContain('0011223344');
    const rows = await q(
      `select response_body::text as b from idempotency_keys where key = $1`,
      [key],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].b).not.toContain('0011223344');
    expect(rows[0].b).not.toContain('qrPayload');
  });

  it('AC-1/5: hai request song song (khóa khác nhau) cùng kỳ chỉ phát hành mỗi hóa đơn một lần, mã không trùng', async () => {
    const { periodId, invoiceIds } = await mkPeriod(
      A,
      Array.from({ length: 12 }, (_, i) => 100_000 + i),
    );
    const [r1, r2] = await Promise.all([
      call(A, `/billing-periods/${periodId}/issue`, { invoiceIds: null }),
      call(A, `/billing-periods/${periodId}/issue`, { invoiceIds: null }),
    ]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect(r1.json().issuedCount + r2.json().issuedCount).toBe(12);
    const rows = await q(
      `select code from invoices where period_id = $1 and status = 'issued'`,
      [periodId],
    );
    expect(new Set(rows.map((r) => r.code)).size).toBe(12);
    expect(await events(A.tenantId, invoiceIds)).toHaveLength(12);
  });

  it('AC-1: invoiceIds chỉ định: chỉ phát hành các hóa đơn đó, đã phát hành → NOT_DRAFT, kỳ còn nháp thì vẫn drafting', async () => {
    const { periodId, invoiceIds } = await mkPeriod(
      A,
      [10_000, 20_000, 30_000],
    );
    const one = await call(A, `/billing-periods/${periodId}/issue`, {
      invoiceIds: [invoiceIds[0]],
    });
    expect(one.json().issuedCount).toBe(1);
    expect((await invoice(invoiceIds[1]!)).status).toBe('draft');
    expect(
      (
        await q(`select status from billing_periods where id = $1`, [periodId])
      )[0].status,
    ).toBe('drafting');
    const two = await call(A, `/billing-periods/${periodId}/issue`, {
      invoiceIds: [invoiceIds[0], invoiceIds[1]],
    });
    expect(two.json().issuedCount).toBe(1);
    expect(two.json().skipped).toEqual([
      { invoiceId: invoiceIds[0], studentName: 'HS 0', reason: 'NOT_DRAFT' },
    ]);
  });

  it('AC-4: tenant chưa có tài khoản nhận tiền → 422 PAYOUT_ACCOUNT_MISSING, không phát hành gì', async () => {
    const { periodId, invoiceIds } = await mkPeriod(C, [100_000, 200_000]);
    const res = await call(C, `/billing-periods/${periodId}/issue`, {
      invoiceIds: null,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('PAYOUT_ACCOUNT_MISSING');
    expect((await invoice(invoiceIds[0]!)).status).toBe('draft');
    expect(await events(C.tenantId, invoiceIds)).toHaveLength(0);
  });

  it('AC-9: 404 chéo tenant (kỳ và hóa đơn), id lạ trong invoiceIds → 404 và không phát hành gì; giáo viên (không phải chủ) → 403; thiếu Idempotency-Key → 422', async () => {
    const a = await mkPeriod(A, [100_000]);
    const b = await mkPeriod(B, [100_000]);
    expect(
      (
        await call(B, `/billing-periods/${a.periodId}/issue`, {
          invoiceIds: null,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(A, `/billing-periods/${a.periodId}/issue`, {
          invoiceIds: [b.invoiceIds[0]],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(A, `/billing-periods/${a.periodId}/issue`, {
          invoiceIds: [a.invoiceIds[0], randomUUID()],
        })
      ).statusCode,
    ).toBe(404);
    expect((await invoice(a.invoiceIds[0]!)).status).toBe('draft');
    expect(
      (
        await call(
          { token: teacherToken },
          `/billing-periods/${a.periodId}/issue`,
          { invoiceIds: null },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          A,
          `/billing-periods/${a.periodId}/issue`,
          { invoiceIds: null },
          null,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (await call(B, `/invoices/${a.invoiceIds[0]}/void`, { reason: 'x' }))
        .statusCode,
    ).toBe(404);
  });

  it('AC-9 (RLS): người dùng tenant B đọc/sửa thẳng DB không thấy hóa đơn đã phát hành của A', async () => {
    const { periodId, invoiceIds } = await mkPeriod(A, [100_000]);
    await call(A, `/billing-periods/${periodId}/issue`, { invoiceIds: null });
    const pool = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [B.userId]);
      expect(
        (await c.query(`select 1 from invoices where id = $1`, [invoiceIds[0]]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await c.query(
            `update invoices set status = 'void', voided_at = now(), void_reason = 'x' where id = $1`,
            [invoiceIds[0]],
          )
        ).rowCount,
      ).toBe(0);
      await c.query('rollback');
    } finally {
      c.release();
      await pool.end();
    }
    expect((await invoice(invoiceIds[0]!)).status).toBe('issued');
  });

  it('S2: hai kỳ cùng tenant phát hành song song → cả hai 200, mã không trùng', async () => {
    const p1 = await mkPeriod(
      A,
      Array.from({ length: 10 }, (_, i) => 1000 + i),
    );
    const p2 = await mkPeriod(
      A,
      Array.from({ length: 10 }, (_, i) => 2000 + i),
    );
    const res = await Promise.all(
      [p1, p2].map((p) =>
        call(A, `/billing-periods/${p.periodId}/issue`, { invoiceIds: null }),
      ),
    );
    expect(res.map((r) => r.statusCode)).toEqual([200, 200]);
    const rows = await q(
      `select code from invoices where period_id = any($1) and status = 'issued'`,
      [[p1.periodId, p2.periodId]],
    );
    expect(new Set(rows.map((r) => r.code)).size).toBe(20);
  });

  it('S6: điều chỉnh song song với phát hành → 409 INVOICE_IMMUTABLE hoặc điều chỉnh vào trước; qr_payload luôn khớp total_amount cuối', async () => {
    for (let i = 0; i < 5; i++) {
      const { periodId, invoiceIds } = await mkPeriod(A, [500_000]);
      const [issue, adj] = await Promise.all([
        call(A, `/billing-periods/${periodId}/issue`, { invoiceIds: null }),
        t.app.inject({
          method: 'POST',
          url: `/v1/invoices/${invoiceIds[0]}/adjustments`,
          payload: {
            amount: -100_000,
            description: 'x',
            adjustmentReason: 'y',
          },
          headers: {
            authorization: `Bearer ${A.token}`,
            'idempotency-key': randomUUID(),
          },
        }),
      ]);
      expect(issue.statusCode, issue.body).toBe(200);
      expect([201, 409]).toContain(adj.statusCode);
      if (adj.statusCode === 409)
        expect(adj.json().code).toBe('INVOICE_IMMUTABLE');
      const row = await invoice(invoiceIds[0]!);
      expect(row.status).toBe('issued');
      expect(Number(row.total_amount)).toBe(
        adj.statusCode === 201 ? 400_000 : 500_000,
      );
      expect(row.qr_payload).toBe(
        buildVietQrPayload({
          bankBin: '970436',
          accountNo: '0011223344',
          amount: Number(row.total_amount),
          transferNote: row.transfer_note,
        }),
      );
    }
  });

  it('N2: kỳ chỉ còn nháp 0 đ → không phát hành gì, kỳ closed', async () => {
    const { periodId, invoiceIds } = await mkPeriod(A, [0, 0]);
    const res = await call(A, `/billing-periods/${periodId}/issue`, {
      invoiceIds: null,
    });
    expect(res.json()).toMatchObject({ issuedCount: 0, totalAmount: 0 });
    expect(res.json().skipped).toHaveLength(2);
    expect((await invoice(invoiceIds[0]!)).status).toBe('draft');
    expect(
      (
        await q(`select status from billing_periods where id = $1`, [periodId])
      )[0].status,
    ).toBe('closed');
  });

  describe('consumer invoice_issued: đường lỗi', () => {
    type Job = {
      eventId: string;
      tenantId: string;
      payload: Record<string, unknown>;
    };
    const st = { mailFail: false, pushFail: false, pushed: 0, mails: 0 };
    let notifier: { handle: (j: unknown) => Promise<void> };
    let pool: pg.Pool;

    beforeAll(async () => {
      const { InvoiceIssuedNotifier } =
        await import('../libs/modules/notifications/application/invoice-issued-notifier.service.js');
      const { AbsenceNotifier } =
        await import('../libs/modules/notifications/application/absence-notifier.service.js');
      const schema = await import('../libs/db/src/schema/index.js');
      const { TxService } = await import('../libs/db/src/tx.service.js');
      pool = new pg.Pool({ connectionString: t.db.url('teachhub_worker') });
      const tx = new TxService(drizzle(pool, { schema, casing: 'snake_case' }));
      notifier = new InvoiceIssuedNotifier(
        tx,
        new AbsenceNotifier(tx, {
          enabled: true,
          send: (ms: unknown[]) => {
            if (st.pushFail)
              return Promise.resolve(
                ms.map(() => ({
                  ok: false as const,
                  error: 'unavailable',
                  invalidToken: false,
                })),
              );
            st.pushed += ms.length;
            return Promise.resolve(
              ms.map(() => ({ ok: true as const, messageId: 'm' })),
            );
          },
        } as never),
        {
          send: () => {
            if (st.mailFail) return Promise.reject(new Error('smtp down'));
            st.mails++;
            return Promise.resolve();
          },
        } as never,
      );
    }, 60_000);
    afterAll(() => pool?.end());
    beforeEach(() =>
      Object.assign(st, {
        mailFail: false,
        pushFail: false,
        pushed: 0,
        mails: 0,
      }),
    );

    /** Một hóa đơn đã phát hành, phụ huynh có (hoặc không có) vai trò parent. */
    const world = async (opts: { parentRole?: boolean } = {}) => {
      const { periodId, invoiceIds } = await mkPeriod(A, [300_000]);
      const parent = randomUUID();
      await q(`insert into users (id, email) values ($1, $2)`, [
        parent,
        `${parent}@example.com`,
      ]);
      await q(
        `insert into devices (id, user_id, platform, token) values ($1, $2, 'android', $3)`,
        [randomUUID(), parent, `tok-${parent}`],
      );
      if (opts.parentRole !== false)
        await q(
          `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
          [randomUUID(), parent],
        );
      await q(
        `insert into guardians (id, tenant_id, student_id, full_name, email, user_id) values ($1, $2, $3, 'PH', 'ph@example.com', $4)`,
        [
          randomUUID(),
          A.tenantId,
          (await invoice(invoiceIds[0]!)).student_id,
          parent,
        ],
      );
      await call(A, `/billing-periods/${periodId}/issue`, { invoiceIds: null });
      const ev = (
        await q(
          `select id, tenant_id, payload from outbox_events where payload->>'invoiceId' = $1`,
          [invoiceIds[0]],
        )
      )[0];
      const job: Job = {
        eventId: ev.id,
        tenantId: ev.tenant_id,
        payload: ev.payload,
      };
      const delivery = async (channel: string) =>
        (
          await q(
            `select d.status from notification_deliveries d join notifications n on n.id = d.notification_id
           where n.recipient_user_id = $1 and d.channel = $2`,
            [parent, channel],
          )
        )[0];
      return { job, parent, delivery };
    };

    it('M2: mailer ném lỗi → handle ném (retry được); gọi lại gửi đúng 1 email, push không gửi lại', async () => {
      const w = await world();
      st.mailFail = true;
      await expect(notifier.handle(w.job)).rejects.toThrow();
      expect((await w.delivery('email')).status).toBe('failed');
      st.mailFail = false;
      await notifier.handle(w.job);
      await notifier.handle(w.job);
      expect(st.mails).toBe(1);
      expect(st.pushed).toBe(1);
      expect((await w.delivery('email')).status).toBe('sent');
    });

    it('M2: push lỗi tạm nhưng email đã sent → gọi lại không gửi email lần hai', async () => {
      const w = await world();
      st.pushFail = true;
      await expect(notifier.handle(w.job)).rejects.toThrow();
      expect(st.mails).toBe(1);
      st.pushFail = false;
      await notifier.handle(w.job);
      expect(st.mails).toBe(1);
      expect(st.pushed).toBe(1);
    });

    it('M1: dòng email queued bỏ dở quá 2 phút được nhận lại và gửi đúng 1 lần; queued còn mới thì không đụng', async () => {
      const w = await world();
      st.mailFail = true;
      await expect(notifier.handle(w.job)).rejects.toThrow();
      st.mailFail = false;
      const setQueued = (age: string) =>
        q(
          `update notification_deliveries set status = 'queued', created_at = now() - $2::interval
           where channel = 'email' and notification_id in (select id from notifications where recipient_user_id = $1)`,
          [w.parent, age],
        );
      await setQueued('10 seconds');
      await notifier.handle(w.job);
      expect(st.mails).toBe(0);
      await setQueued('5 minutes');
      await notifier.handle(w.job);
      await notifier.handle(w.job);
      expect(st.mails).toBe(1);
      expect((await w.delivery('email')).status).toBe('sent');
    });

    it('M2/S4: phụ huynh có user_id nhưng không có vai trò parent → không thông báo, không email, có log warn không kèm PII', async () => {
      const w = await world({ parentRole: false });
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await notifier.handle(w.job);
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
      expect(
        msgs.some((m) => /1 phụ huynh chưa có vai trò parent/.test(m)),
      ).toBe(true);
      expect(msgs.join()).not.toMatch(/ph@example\.com|HS /);
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          w.parent,
        ]),
      ).toHaveLength(0);
      expect(st.mails + st.pushed).toBe(0);
    });

    it('M2: hai worker cùng event song song → mỗi kênh đúng 1 lần', async () => {
      const w = await world();
      await Promise.allSettled([
        notifier.handle(w.job),
        notifier.handle(w.job),
      ]);
      await notifier.handle(w.job).catch(() => undefined);
      expect(st.pushed).toBe(1);
      expect(st.mails).toBe(1);
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          w.parent,
        ]),
      ).toHaveLength(1);
    });

    it('M2: event totalAmount = 0 → job lỗi, không thông báo, không gửi', async () => {
      const w = await world();
      await q(`delete from notifications where recipient_user_id = $1`, [
        w.parent,
      ]);
      await expect(
        notifier.handle({
          ...w.job,
          payload: { ...w.job.payload, totalAmount: 0 },
        }),
      ).rejects.toThrow();
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          w.parent,
        ]),
      ).toHaveLength(0);
      expect(st.mails + st.pushed).toBe(0);
    });
  });

  describe('void', () => {
    it('AC-7: hủy hóa đơn đã phát hành có lý do, ghi audit, không đổi số tiền; gọi lại vẫn 200', async () => {
      const { periodId, invoiceIds } = await mkPeriod(A, [700_000]);
      await call(A, `/billing-periods/${periodId}/issue`, { invoiceIds: null });
      const id = invoiceIds[0]!;
      const before = await invoice(id);

      expect(
        (await call(A, `/invoices/${id}/void`, { reason: '  ' })).statusCode,
      ).toBe(422);
      const res = await call(A, `/invoices/${id}/void`, {
        reason: 'Sai số buổi học',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        replacementInvoiceId: null,
        invoice: {
          id,
          status: 'void',
          voidReason: 'Sai số buổi học',
          totalAmount: 700_000,
          code: before.code,
        },
      });
      const row = await invoice(id);
      expect(row.status).toBe('void');
      expect(Number(row.total_amount)).toBe(700_000);
      expect(row.voided_at).not.toBeNull();
      const audit = await q(
        `select after_data, actor_user_id from audit_logs where tenant_id = $1 and entity = 'invoice' and entity_id = $2 and after_data->>'status' = 'void'`,
        [A.tenantId, id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].after_data.reason).toBe('Sai số buổi học');

      const again = await call(A, `/invoices/${id}/void`, {
        reason: 'Lý do khác',
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().invoice.voidReason).toBe('Sai số buổi học');
      // Hóa đơn hủy không còn phải trả.
      expect(again.json().invoice).toMatchObject({
        status: 'void',
        paidAmount: 0,
        remainingAmount: 0,
      });
    });

    it('AC-7: hóa đơn nháp → 409 CONFLICT_STALE; createReplacementDraft chờ TL xác nhận → 422 và không hủy', async () => {
      const { periodId, invoiceIds } = await mkPeriod(A, [50_000, 60_000]);
      const draft = await call(A, `/invoices/${invoiceIds[0]}/void`, {
        reason: 'x',
      });
      expect(draft.statusCode).toBe(409);
      expect(draft.json().code).toBe('CONFLICT_STALE');
      await call(A, `/billing-periods/${periodId}/issue`, {
        invoiceIds: [invoiceIds[1]],
      });
      const rep = await call(A, `/invoices/${invoiceIds[1]}/void`, {
        reason: 'x',
        createReplacementDraft: true,
      });
      expect(rep.statusCode).toBe(422);
      expect((await invoice(invoiceIds[1]!)).status).toBe('issued');
    });
  });

  describe('AC-6: consumer invoice_issued (push + email phụ huynh)', () => {
    it('tạo thông báo, gửi push và một email; xử lý lại không gửi trùng; hóa đơn đã hủy không báo', async () => {
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
      const pushed: unknown[] = [];
      const mails: { to: string; subject: string; text: string }[] = [];
      const notifier = new InvoiceIssuedNotifier(
        tx,
        new AbsenceNotifier(tx, {
          enabled: true,
          send: (ms: unknown[]) => {
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

      const { periodId, invoiceIds } = await mkPeriod(A, [300_000, 400_000]);
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
      const studentOf = async (id: string) =>
        (await invoice(id)).student_id as string;
      const stu0 = await studentOf(invoiceIds[0]!);
      await q(
        `insert into guardians (id, tenant_id, student_id, full_name, email, user_id) values ($1, $2, $3, 'PH', 'ph@example.com', $4)`,
        [randomUUID(), A.tenantId, stu0, parent],
      );
      await call(A, `/billing-periods/${periodId}/issue`, { invoiceIds: null });
      const jobs = (
        await q(
          `select id, tenant_id, payload from outbox_events where type = 'invoice_issued' and payload->>'invoiceId' = any($1)`,
          [invoiceIds],
        )
      ).map((r) => ({
        eventId: r.id,
        tenantId: r.tenant_id,
        payload: r.payload,
      }));
      expect(jobs).toHaveLength(2);
      const mine = jobs.find((j) => j.payload.invoiceId === invoiceIds[0])!;
      const other = jobs.find((j) => j.payload.invoiceId === invoiceIds[1])!;

      await notifier.handle(mine);
      await notifier.handle(mine);
      const notes = await q(
        `select type, urgency, payload from notifications where recipient_user_id = $1`,
        [parent],
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        type: 'invoice_issued',
        urgency: 'normal',
      });
      expect(notes[0].payload).toMatchObject({
        invoiceId: invoiceIds[0],
        studentName: 'HS 0',
        totalAmount: 300_000,
      });
      expect(pushed).toHaveLength(1);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe('ph@example.com');
      expect(mails[0]!.subject + mails[0]!.text).not.toMatch(/HS 0|300/);

      // Học viên không có phụ huynh liên kết: không thông báo, không lỗi.
      await notifier.handle(other);
      expect(mails).toHaveLength(1);

      // Hủy trước khi worker xử lý: không báo.
      const second = await mkPeriod(A, [100_000]);
      await q(
        `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'PH2', $4)`,
        [
          randomUUID(),
          A.tenantId,
          await studentOf(second.invoiceIds[0]!),
          parent,
        ],
      );
      await call(A, `/billing-periods/${second.periodId}/issue`, {
        invoiceIds: null,
      });
      await call(A, `/invoices/${second.invoiceIds[0]}/void`, {
        reason: 'nhầm',
      });
      const ev = (
        await q(
          `select id, tenant_id, payload from outbox_events where payload->>'invoiceId' = $1`,
          [second.invoiceIds[0]],
        )
      )[0];
      await notifier.handle({
        eventId: ev.id,
        tenantId: ev.tenant_id,
        payload: ev.payload,
      });
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          parent,
        ]),
      ).toHaveLength(1);
      await pool.end();
    });
  });
});
