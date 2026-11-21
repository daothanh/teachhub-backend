import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { BillingCloseJob } from '../libs/modules/billing/application/billing-close.job.js';
import type { BillingReadyNotifier } from '../libs/modules/notifications/application/billing-ready-notifier.service.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// Kỳ 12/2026 chốt vào ngày billingCloseDay của tháng sau (mặc định 1), job chạy 02:00 giờ VN.
const CLOSE_A = new Date('2026-12-31T19:00:00Z'); // 02:00 ngày 01/01/2027 giờ VN
const CLOSE_B = new Date('2027-01-04T19:00:00Z'); // 02:00 ngày 05/01/2027: ngày chốt 5 của tenant B

// S5-BE-05 + S5-BE-06: job billing.close, API kỳ thu / hóa đơn / điều chỉnh, cô lập tenant.
describe('billing: job billing.close + API kỳ thu, hóa đơn, điều chỉnh', () => {
  let t: TestApp;
  let pool: pg.Pool;
  let job: BillingCloseJob;
  let notifier: BillingReadyNotifier;
  let pushed: {
    token: string;
    urgent: boolean;
    copy: { title: string; channelId: string };
    data: Record<string, string>;
  }[];
  let A: Who;
  let B: Who;
  let E: Who;
  let G: Who;
  const ids = {
    clsPer: randomUUID(),
    clsMonthly: randomUUID(),
    clsNoFee: randomUUID(),
    stu1: randomUUID(),
    stu2: randomUUID(),
    stu3: randomUUID(),
    stu4: randomUUID(),
    stu5: randomUUID(),
    stu6: randomUUID(),
    stu7: randomUUID(),
    clsEdge: randomUUID(),
    clsB: randomUUID(),
    stuB: randomUUID(),
  };
  const sess = Array.from({ length: 8 }, () => randomUUID());

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    who: Who,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    key: string | null = randomUUID(),
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(method === 'GET' || !key ? {} : { 'idempotency-key': key }),
      },
    });
  const addClass = (
    tenant: SeededTenant,
    id: string,
    name: string,
    fee: [string, number, object | null] | null,
  ) =>
    q(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, fee_type, fee_amount, fee_rules)
       values ($1, $2, $3, $4, 'Toán', 9, 'online', '2026-11-01', $5, $6, $7)`,
      [
        id,
        tenant.tenantId,
        tenant.branchId,
        name,
        fee?.[0] ?? null,
        fee?.[1] ?? null,
        fee?.[2] ? JSON.stringify(fee[2]) : null,
      ],
    );
  const addStudent = (
    tenant: SeededTenant,
    id: string,
    name: string,
    status = 'active',
  ) =>
    q(
      `insert into students (id, tenant_id, full_name, status) values ($1, $2, $3, $4)`,
      [id, tenant.tenantId, name, status],
    );
  const enroll = (
    tenant: SeededTenant,
    classId: string,
    studentId: string,
    over: { leftOn?: string; override?: object } = {},
  ) =>
    q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on, left_on, fee_override)
       values ($1, $2, $3, $4, '2026-11-01', $5, $6)`,
      [
        randomUUID(),
        tenant.tenantId,
        classId,
        studentId,
        over.leftOn ?? null,
        over.override ? JSON.stringify(over.override) : null,
      ],
    );
  const attend = (
    tenant: SeededTenant,
    sessionId: string,
    studentId: string,
    status: string,
  ) =>
    q(
      `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at)
       values ($1, $2, $3, $4, $5, now())`,
      [randomUUID(), tenant.tenantId, sessionId, studentId, status],
    );

  beforeAll(async () => {
    t = await startTestApp();
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    const { BillingCloseJob } =
      await import('../libs/modules/billing/application/billing-close.job.js');
    const { AbsenceNotifier } =
      await import('../libs/modules/notifications/application/absence-notifier.service.js');
    const { BillingReadyNotifier } =
      await import('../libs/modules/notifications/application/billing-ready-notifier.service.js');
    pool = new pg.Pool({ connectionString: t.db.url('teachhub_worker') });
    const tx = new TxService(drizzle(pool, { schema, casing: 'snake_case' }));
    job = new BillingCloseJob(tx, new JobRuns(tx));
    pushed = [];
    const fakePush = {
      enabled: true,
      send: (ms: typeof pushed) => {
        pushed.push(...ms);
        return Promise.resolve(
          ms.map(() => ({ ok: true as const, messageId: 'm' })),
        );
      },
    };
    notifier = new BillingReadyNotifier(
      tx,
      new AbsenceNotifier(tx, fakePush as never),
    );

    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B, E, G] = [await mk(), await mk(), await mk(), await mk()];

    // Tenant A: lớp theo buổi (2 học viên + 1 tạm nghỉ + 1 đã rời), lớp theo tháng (stu1), lớp chưa có học phí (stu3).
    await addClass(A, ids.clsPer, 'Toán 9A', ['per_session', 150_000, null]);
    await addClass(A, ids.clsMonthly, 'Văn 9A', ['monthly', 1_000_000, null]);
    await addClass(A, ids.clsNoFee, 'Anh 9A', null);
    await addStudent(A, ids.stu1, 'An');
    await addStudent(A, ids.stu2, 'Bình');
    await addStudent(A, ids.stu3, 'Chi');
    await addStudent(A, ids.stu4, 'Dũng', 'paused');
    await addStudent(A, ids.stu5, 'Em');
    await addStudent(A, ids.stu6, 'Giang', 'left');
    await addStudent(A, ids.stu7, 'Hà');
    await addClass(A, ids.clsEdge, 'Sử 9A', ['per_session', 100_000, null]);
    await enroll(A, ids.clsPer, ids.stu1);
    await enroll(A, ids.clsPer, ids.stu2, {
      override: { chargeExcused: false, chargeUnexcused: false, discounts: [] },
    });
    await enroll(A, ids.clsPer, ids.stu4);
    await enroll(A, ids.clsPer, ids.stu5, { leftOn: '2026-11-30' });
    await enroll(A, ids.clsPer, ids.stu6);
    await enroll(A, ids.clsMonthly, ids.stu1);
    await enroll(A, ids.clsMonthly, ids.stu4);
    await enroll(A, ids.clsEdge, ids.stu7);
    // Hà: 30/11 và 02/01 ngoài kỳ 12/2026; 10/12 còn planned (chưa điểm danh); 31/12 là ngày cuối kỳ, đã dạy.
    for (const [d, status] of [
      ['2026-11-30', 'taught'],
      ['2026-12-10', 'planned'],
      ['2026-12-31', 'taught'],
      ['2027-01-02', 'taught'],
    ] as const)
      await q(
        `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          A.tenantId,
          ids.clsEdge,
          d,
          `${d}T11:00:00Z`,
          `${d}T12:00:00Z`,
          status,
        ],
      );
    await enroll(A, ids.clsNoFee, ids.stu3);
    for (const [i, id] of sess.entries()) {
      const d = `2026-12-${String(i + 1).padStart(2, '0')}`;
      await q(
        `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5, $6, 'taught')`,
        [id, A.tenantId, ids.clsPer, d, `${d}T11:00:00Z`, `${d}T12:00:00Z`],
      );
    }
    for (const stu of [ids.stu1, ids.stu2]) {
      await attend(A, sess[6]!, stu, 'excused');
      await attend(A, sess[7]!, stu, 'unexcused');
    }

    // Tenant B: ngày chốt 5, một học viên theo tháng.
    await q(
      `update tenants set settings = '{"billingCloseDay": 5}' where id = $1`,
      [B.tenantId],
    );
    await addClass(B, ids.clsB, 'Lý 9B', ['monthly', 700_000, null]);
    await addStudent(B, ids.stuB, 'Bảo');
    // Vào lớp từ 01/12: không có gì phải thu cho kỳ 11/2026 mà catch-up của B (ngày chốt 5) xét ở lần chạy đầu.
    await q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, '2026-12-01')`,
      [randomUUID(), B.tenantId, ids.clsB, ids.stuB],
    );

    // Tenant E (vector tổng): lớp theo buổi 150.000 (1 buổi) + lớp theo tháng 1.000.000 có miễn giảm 1.500.000 (> học phí).
    const [eA, eB, eStu] = [randomUUID(), randomUUID(), randomUUID()];
    await addClass(E, eA, 'E-Toán', ['per_session', 150_000, null]);
    await addClass(E, eB, 'E-Văn', ['monthly', 1_000_000, null]);
    await addStudent(E, eStu, 'Ê');
    await enroll(E, eA, eStu);
    await enroll(E, eB, eStu, {
      override: {
        discounts: [{ kind: 'amount', amount: 1_500_000, description: 'Miễn' }],
      },
    });
    const eSess = randomUUID();
    await q(
      `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
       values ($1, $2, $3, '2026-12-05', '2026-12-05T11:00:00Z', '2026-12-05T12:00:00Z', 'taught')`,
      [eSess, E.tenantId, eA],
    );

    // Tenant G: một học viên có tổng vượt trần 100 tỷ (101 buổi × 1 tỷ) bị bỏ qua, học viên còn lại vẫn có bản nháp.
    const [gBig, gSmall, gX, gY] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await addClass(G, gBig, 'G-Lớn', ['per_session', 1_000_000_000, null]);
    await addClass(G, gSmall, 'G-Nhỏ', ['monthly', 100_000, null]);
    await addStudent(G, gX, 'Xuân');
    await addStudent(G, gY, 'Yên');
    await enroll(G, gBig, gX);
    await enroll(G, gSmall, gY);
    for (let i = 0; i < 101; i++) {
      const d = `2026-12-${String((i % 28) + 1).padStart(2, '0')}`;
      await q(
        `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5, $6, 'taught')`,
        [randomUUID(), G.tenantId, gBig, d, `${d}T11:00:00Z`, `${d}T12:00:00Z`],
      );
    }
  }, 180_000);
  afterAll(async () => {
    await pool?.end();
    await t?.stop();
  });

  const periodsOf = (who: SeededTenant) =>
    q(
      `select id, status, period_month::text, close_date::text, due_date::text from billing_periods where tenant_id = $1`,
      [who.tenantId],
    );
  const invoicesOf = (who: SeededTenant) =>
    q(
      `select i.*, s.full_name from invoices i join students s on s.id = i.student_id where i.tenant_id = $1 order by s.full_name`,
      [who.tenantId],
    );

  it('AC-1 + D1/D3/D4: ngày chốt 01/01 → kỳ 12/2026 gồm buổi 31/12, buổi planned thành dòng 0 đ; lớp chưa học phí/đã rời bị bỏ, tạm nghỉ chỉ tính theo buổi, tổng vượt trần bị bỏ qua', async () => {
    // A (4) + E (1) + G (1: Yên; Xuân vượt trần bị bỏ qua mà job không hỏng); B chưa tới ngày chốt và không có gì cho kỳ 11/2026.
    expect(await job.run(CLOSE_A)).toBe(6);
    const [period] = await periodsOf(A);
    expect(period).toMatchObject({
      period_month: '2026-12-01',
      close_date: '2027-01-01',
      due_date: '2027-01-11',
      status: 'drafting',
    });
    const inv = await invoicesOf(A);
    // An: 8 buổi lớp theo buổi (vắng cả hai loại vẫn tính) = 1.200.000 + 1.000.000 lớp theo tháng.
    // Bình: ghi đè tắt cả hai loại vắng → 6 × 150.000 = 900.000.
    expect(
      inv.map((i) => [i.full_name, i.status, Number(i.total_amount)]),
    ).toEqual([
      ['An', 'draft', 2_200_000],
      ['Bình', 'draft', 900_000],
      ['Dũng', 'draft', 1_200_000], // tạm nghỉ: chỉ tiền theo buổi đã dạy, không thu học phí tháng
      ['Hà', 'draft', 100_000], // 31/12 đã dạy tính; 10/12 planned là dòng 0 đ; 30/11 và 02/01 ngoài kỳ
    ]);
    expect(inv.every((i) => i.code === null && i.period_id === period.id)).toBe(
      true,
    );

    const lines = await q(
      `select kind, class_name, amount::int, charged, not_charged_reason, session_id, session_date::text
         from invoice_lines where invoice_id = $1 order by position`,
      [inv[1]!.id],
    );
    expect(lines).toHaveLength(8);
    expect(
      lines.filter((l) => !l.charged).map((l) => l.not_charged_reason),
    ).toEqual(['excused_not_charged', 'unexcused_not_charged']);
    expect(lines[0]).toMatchObject({
      kind: 'session',
      class_name: 'Toán 9A',
      amount: 150_000,
      session_date: '2026-12-01',
    });
    const an = await q(
      `select class_name, kind from invoice_lines where invoice_id = $1 order by position`,
      [inv[0]!.id],
    );
    expect(an.map((l) => l.class_name)).toEqual([
      ...Array(8).fill('Toán 9A'),
      'Văn 9A',
    ]);
    expect(an.at(-1)!.kind).toBe('monthly');
    const dung = await q(
      `select kind from invoice_lines where invoice_id = $1`,
      [inv[2]!.id],
    );
    expect(dung.every((l) => l.kind === 'session')).toBe(true);
    const ha = await q(
      `select amount::int, charged, not_charged_reason, description, session_date::text from invoice_lines where invoice_id = $1 order by position`,
      [inv[3]!.id],
    );
    expect(ha).toHaveLength(2);
    expect(ha[0]).toMatchObject({ amount: 0, session_date: '2026-12-10' });
    expect(ha[0].description).toContain('chưa điểm danh');
    expect(ha[1]).toMatchObject({
      amount: 100_000,
      session_date: '2026-12-31',
    });
    // Tổng vượt trần: học viên Xuân không có hóa đơn, tenant G không bị hỏng.
    expect((await invoicesOf(G)).map((i) => i.full_name)).toEqual(['Yên']);
    const log = await q(
      `select status from job_runs where job = 'billing.close' order by started_at desc limit 1`,
    );
    expect(log[0].status).toBe('succeeded');
  });

  it('AC-2: chạy lại cùng ngày → không sinh bản nháp trùng, không ghi thêm outbox; học viên đã phát hành cũng không có bản nháp thứ hai', async () => {
    expect(await job.run(CLOSE_A)).toBe(0);
    expect(await invoicesOf(A)).toHaveLength(4);
    expect(await periodsOf(A)).toHaveLength(1);
    expect(
      await q(
        `select 1 from outbox_events where tenant_id = $1 and type = 'billing_drafts_ready'`,
        [A.tenantId],
      ),
    ).toHaveLength(1);

    // Bình phát hành rồi chạy lại: vẫn không có bản nháp mới cho Bình.
    const [binh] = (await invoicesOf(A)).filter((i) => i.full_name === 'Bình');
    await q(
      `update invoices set status = 'issued', code = 'TH-25K7Q9', transfer_note = 'TH 25K7Q9', qr_payload = '000201',
         payout = '{"bankBin":"970436","accountNo":"0123456789","accountName":"A"}'::jsonb, issued_at = now() where id = $1`,
      [binh!.id],
    );
    expect(await job.run(CLOSE_A)).toBe(0);
    expect((await invoicesOf(A)).map((i) => i.status)).toEqual([
      'draft',
      'issued',
      'draft',
      'draft',
    ]);
  });

  it('AC-3: ghi đúng một sự kiện outbox billing_drafts_ready cùng giao dịch; consumer tạo thông báo + push data-only cho chủ tenant, xử lý lại không gửi trùng', async () => {
    const [ev] = await q(
      `select id, payload, next_attempt_at from outbox_events where tenant_id = $1 and type = 'billing_drafts_ready'`,
      [A.tenantId],
    );
    // Giờ yên lặng: job chạy 02:00 VN (19:00Z) → sự kiện hẹn 07:00 VN ngày 01/01/2027 (00:00Z).
    expect(new Date(ev.next_attempt_at).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    const [period] = await periodsOf(A);
    expect(ev.payload).toEqual({
      periodId: period.id,
      periodMonth: '2026-12-01',
      draftCount: 4,
      draftTotalAmount: 4_400_000,
    });

    await q(
      `insert into devices (id, user_id, platform, token) values ($1, $2, 'android', 'tok-billing-a')`,
      [randomUUID(), A.userId],
    );
    const data = {
      eventId: ev.id as string,
      tenantId: A.tenantId,
      payload: ev.payload,
    };
    // Dữ liệu job sai dạng bị từ chối, không nuốt im lặng.
    await expect(notifier.handle({ eventId: 'x' })).rejects.toThrow();
    await notifier.handle(data);
    await notifier.handle(data);
    const notis = await q(
      `select type, urgency, payload, recipient_user_id from notifications where tenant_id = $1`,
      [A.tenantId],
    );
    expect(notis).toHaveLength(1);
    expect(notis[0]).toMatchObject({
      type: 'billing_ready',
      urgency: 'normal',
      recipient_user_id: A.userId,
    });
    expect(notis[0].payload).toEqual(ev.payload);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      token: 'tok-billing-a',
      urgent: false,
      copy: { title: 'Học phí đã sẵn sàng', channelId: 'billing' },
    });
    expect(JSON.stringify(pushed)).not.toContain(
      String(ev.payload.draftTotalAmount),
    );
    // Push chỉ có id thông báo và loại: không có số tiền hay tên con.
    expect(Object.keys(pushed[0]!.data).sort()).toEqual([
      'notificationId',
      'type',
    ]);
  });

  it('chia lô theo tenant: B chốt ngày 5 chỉ tạo kỳ của B, không đụng dữ liệu A', async () => {
    expect(await job.run(CLOSE_B)).toBe(1);
    const [pb] = await periodsOf(B);
    expect(pb).toMatchObject({
      period_month: '2026-12-01',
      close_date: '2027-01-05',
      due_date: '2027-01-15',
    });
    const invB = await invoicesOf(B);
    expect(invB.map((i) => [i.full_name, Number(i.total_amount)])).toEqual([
      ['Bảo', 700_000],
    ]);
    expect(await periodsOf(A)).toHaveLength(1);
    expect(await invoicesOf(A)).toHaveLength(4);
  });

  it('AC-6 (RLS): người dùng tenant A đọc thẳng DB chỉ thấy dòng của A, billing_periods/invoices/invoice_lines của B = 0 dòng', async () => {
    const app = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [
        A.userId,
      ]);
      const count = async (table: string, tenant: string) =>
        (
          await client.query(
            `select count(*)::int n from ${table} where tenant_id = $1`,
            [tenant],
          )
        ).rows[0].n as number;
      for (const table of ['billing_periods', 'invoices', 'invoice_lines']) {
        expect(await count(table, B.tenantId), table).toBe(0);
        expect(await count(table, A.tenantId), table).toBeGreaterThan(0);
        expect(
          (
            await client.query(
              `select count(*)::int n from ${table} where tenant_id <> $1`,
              [A.tenantId],
            )
          ).rows[0].n,
          table,
        ).toBe(0);
      }
      await client.query('rollback');
    } finally {
      client.release();
      await app.end();
    }
  });

  describe('API', () => {
    let periodA: string;
    let draftAn: string;
    let draftBinh: string;

    beforeAll(async () => {
      periodA = (await periodsOf(A))[0].id;
      const inv = await invoicesOf(A);
      draftAn = inv.find((i) => i.full_name === 'An')!.id;
      draftBinh = inv.find((i) => i.full_name === 'Bình')!.id;
    });

    it('AC-4: GET /billing-periods: mới nhất trước, đếm theo trạng thái, lọc month, chỉ kỳ của tenant mình', async () => {
      const res = await call(A, 'GET', '/billing-periods');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        items: [
          {
            id: periodA,
            periodMonth: '2026-12-01',
            closeDate: '2027-01-01',
            dueDate: '2027-01-11',
            status: 'drafting',
            draftCount: 3,
            issuedCount: 1,
            voidCount: 0,
            draftTotalAmount: 3_500_000,
            issuedTotalAmount: 900_000,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      expect(
        (await call(A, 'GET', '/billing-periods?month=2026-11')).json().items,
      ).toEqual([]);
      expect(
        (await call(A, 'GET', '/billing-periods?month=2026-12')).json().total,
      ).toBe(1);
      expect(
        (await call(A, 'GET', '/billing-periods?month=13-2026')).statusCode,
      ).toBe(422);
      expect(
        (await call(B, 'GET', '/billing-periods'))
          .json()
          .items.map((p: { periodMonth: string }) => p.periodMonth),
      ).toEqual(['2026-12-01']);
    });

    it('AC-4: GET /billing-periods/{id}: tổng quan + hóa đơn sắp theo tên, lọc status, nhãn Giá riêng', async () => {
      const res = await call(A, 'GET', `/billing-periods/${periodA}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        id: periodA,
        draftCount: 3,
        issuedCount: 1,
        status: 'drafting',
      });
      expect(
        body.invoices.items.map((i: Record<string, unknown>) => [
          i.studentName,
          i.status,
          i.totalAmount,
          i.hasOverride,
          i.code,
        ]),
      ).toEqual([
        ['An', 'draft', 2_200_000, false, null],
        ['Bình', 'issued', 900_000, true, 'TH-25K7Q9'],
        ['Dũng', 'draft', 1_200_000, false, null],
        ['Hà', 'draft', 100_000, false, null],
      ]);
      expect(body.invoices.total).toBe(4);
      const drafts = await call(
        A,
        'GET',
        `/billing-periods/${periodA}?status=draft&pageSize=1`,
      );
      expect(drafts.json().invoices).toMatchObject({ total: 3, pageSize: 1 });
      expect(drafts.json().invoices.items[0].studentName).toBe('An');
    });

    it('AC-4 (US-7.2 AC2): GET /invoices/{id}: từng buổi tính/không tính kèm lý do, snapshot dòng', async () => {
      const res = await call(A, 'GET', `/invoices/${draftBinh}`);
      expect(res.statusCode, res.body).toBe(200);
      const inv = res.json();
      expect(inv).toMatchObject({
        id: draftBinh,
        periodId: periodA,
        periodMonth: '2026-12-01',
        status: 'issued',
        studentName: 'Bình',
        totalAmount: 900_000,
        dueDate: '2027-01-11',
        clampedAmount: 0,
        replacesInvoiceId: null,
      });
      expect(inv.lines).toHaveLength(8);
      expect(inv.lines[6]).toMatchObject({
        kind: 'session',
        charged: false,
        amount: 0,
        notChargedReason: 'excused_not_charged',
        sessionDate: '2026-12-07',
        className: 'Toán 9A',
        adjustmentReason: null,
      });
      expect(inv.lines[0]).toMatchObject({
        charged: true,
        notChargedReason: null,
        amount: 150_000,
      });
      expect(inv.issuedAt).toMatch(/\+07:00$/);
      const an = (await call(A, 'GET', `/invoices/${draftAn}`)).json();
      expect(an.lines.map((l: { kind: string }) => l.kind).at(-1)).toBe(
        'monthly',
      );
      expect(an.totalAmount).toBe(2_200_000);
    });

    it('AC-6: tenant B không xem kỳ thu, hóa đơn, điều chỉnh của A (404); id lạ cũng 404', async () => {
      for (const url of [
        `/billing-periods/${periodA}`,
        `/invoices/${draftAn}`,
        `/invoices/${randomUUID()}`,
      ]) {
        const res = await call(B, 'GET', url);
        expect(res.statusCode, url).toBe(404);
        expect(res.json().code).toBe('NOT_FOUND');
      }
      const adj = await call(B, 'POST', `/invoices/${draftAn}/adjustments`, {
        amount: -1000,
        description: 'x',
        adjustmentReason: 'y',
      });
      expect(adj.statusCode).toBe(404);
      expect(
        (await invoicesOf(A)).find((i) => i.id === draftAn)!.total_amount,
      ).toBe('2200000');
      expect(
        await q(
          `select 1 from invoice_lines where invoice_id = $1 and kind = 'manual_adjustment'`,
          [draftAn],
        ),
      ).toHaveLength(0);
    });

    it('chỉ chủ tenant: nhân sự vai trò khác → 403', async () => {
      const teacher = await seedMember(t.worker, A.tenantId, 'teacher');
      const who = { ...A, token: await t.tokenFor(teacher) };
      expect((await call(who, 'GET', '/billing-periods')).statusCode).toBe(403);
      expect((await call(who, 'GET', `/invoices/${draftAn}`)).statusCode).toBe(
        403,
      );
    });

    it('AC-5: điều chỉnh bản nháp: bắt buộc lý do, thêm dòng, cập nhật tổng, ghi audit với người sửa', async () => {
      const body = {
        amount: -200_000,
        description: 'Giảm buổi học thử',
        adjustmentReason: 'Thỏa thuận với phụ huynh',
      };
      for (const bad of [
        { ...body, adjustmentReason: '   ' },
        { amount: body.amount, description: body.description },
        { ...body, amount: 0 },
      ])
        expect(
          (await call(A, 'POST', `/invoices/${draftAn}/adjustments`, bad))
            .statusCode,
        ).toBe(422);
      expect(
        (await call(A, 'POST', `/invoices/${draftAn}/adjustments`, body, null))
          .statusCode,
      ).toBe(422); // thiếu Idempotency-Key

      const key = randomUUID();
      const res = await call(
        A,
        'POST',
        `/invoices/${draftAn}/adjustments`,
        body,
        key,
      );
      expect(res.statusCode, res.body).toBe(201);
      const inv = res.json();
      expect(inv.totalAmount).toBe(2_000_000);
      expect(inv.clampedAmount).toBe(0);
      expect(inv.lines.at(-1)).toMatchObject({
        kind: 'manual_adjustment',
        amount: -200_000,
        charged: true,
        description: 'Giảm buổi học thử',
        adjustmentReason: 'Thỏa thuận với phụ huynh',
        className: null,
        sessionId: null,
      });
      expect(inv.lines).toHaveLength(10);

      // Gửi lặp cùng khóa: cùng kết quả, không thêm dòng.
      const again = await call(
        A,
        'POST',
        `/invoices/${draftAn}/adjustments`,
        body,
        key,
      );
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json().lines).toHaveLength(10);

      expect(
        await q(`select total_amount::int from invoices where id = $1`, [
          draftAn,
        ]),
      ).toEqual([{ total_amount: 2_000_000 }]);
      const audit = await q(
        `select actor_user_id, entity, action, before_data, after_data from audit_logs where entity_id = $1`,
        [draftAn],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_user_id: A.userId,
        entity: 'invoice_adjustment',
        action: 'update',
      });
      expect(audit[0].before_data).toEqual({
        totalAmount: 2_200_000,
        clampedAmount: 0,
      });
      expect(audit[0].after_data).toEqual({
        totalAmount: 2_000_000,
        clampedAmount: 0,
        adjustment: {
          amount: -200_000,
          description: 'Giảm buổi học thử',
          reason: 'Thỏa thuận với phụ huynh',
        },
      });
    });

    it('AC-5: tổng âm bị cắt về 0 và ghi clampedAmount; tối đa 20 dòng điều chỉnh', async () => {
      const big = await call(A, 'POST', `/invoices/${draftAn}/adjustments`, {
        amount: -2_500_000,
        description: 'Miễn',
        adjustmentReason: 'Hỗ trợ',
      });
      expect(big.statusCode, big.body).toBe(201);
      expect(big.json()).toMatchObject({
        totalAmount: 0,
        clampedAmount: 500_000,
      });
      // Đã có 2 dòng điều chỉnh; thêm tới 20 rồi dòng thứ 21 bị từ chối.
      for (let i = 0; i < 18; i++)
        expect(
          (
            await call(A, 'POST', `/invoices/${draftAn}/adjustments`, {
              amount: 1000,
              description: `d${i}`,
              adjustmentReason: 'r',
            })
          ).statusCode,
        ).toBe(201);
      const over = await call(A, 'POST', `/invoices/${draftAn}/adjustments`, {
        amount: 1000,
        description: 'quá',
        adjustmentReason: 'r',
      });
      expect(over.statusCode).toBe(422);
      expect(over.json().code).toBe('VALIDATION_FAILED');
    });

    it('M2: tổng = max(0, Σ ghi danh đã cắt + Σ điều chỉnh): 2 lớp, lớp B miễn giảm vượt học phí → B = 0, +1.000 → A + 1.000', async () => {
      const [inv] = await q(
        `select id, total_amount::int from invoices where tenant_id = $1`,
        [E.tenantId],
      );
      expect(inv.total_amount).toBe(150_000);
      const key = randomUUID();
      const up = await call(
        E,
        'POST',
        `/invoices/${inv.id}/adjustments`,
        { amount: 1000, description: 'Phụ thu', adjustmentReason: 'Tài liệu' },
        key,
      );
      expect(up.statusCode, up.body).toBe(201);
      expect(up.json()).toMatchObject({
        totalAmount: 151_000,
        clampedAmount: 0,
      });
      // Điều chỉnh âm vượt tổng: cắt về 0, phần dư = 49.000 (151.000 − 200.000), cộng lại +1.000 thì tính từ tổng chưa cắt.
      const down = await call(E, 'POST', `/invoices/${inv.id}/adjustments`, {
        amount: -200_000,
        description: 'Giảm',
        adjustmentReason: 'Hỗ trợ',
      });
      expect(down.json()).toMatchObject({
        totalAmount: 0,
        clampedAmount: 49_000,
      });
      const back = await call(E, 'POST', `/invoices/${inv.id}/adjustments`, {
        amount: 59_000,
        description: 'Thu bù',
        adjustmentReason: 'Sửa',
      });
      expect(back.json()).toMatchObject({
        totalAmount: 10_000,
        clampedAmount: 0,
      });
    });

    it('AC-5 (D1/D3): hóa đơn Hà: buổi 31/12 đã dạy có tính, buổi 10/12 planned là dòng 0 đ chưa điểm danh, buổi ngoài tháng không vào', async () => {
      const ha = (await invoicesOf(A)).find((i) => i.full_name === 'Hà')!;
      const inv = (await call(A, 'GET', `/invoices/${ha.id}`)).json();
      expect(inv.totalAmount).toBe(100_000);
      expect(
        inv.lines.map((l: { sessionDate: string; amount: number }) => [
          l.sessionDate,
          l.amount,
        ]),
      ).toEqual([
        ['2026-12-10', 0],
        ['2026-12-31', 100_000],
      ]);
      expect(inv.lines[0].description).toContain('chưa điểm danh');
    });

    it('AC-5: điều chỉnh làm tổng vượt 100 tỷ → 422 VALIDATION_FAILED ở amount, tiền không đổi', async () => {
      const ha = (await invoicesOf(A)).find((i) => i.full_name === 'Hà')!;
      // Tổng = Σ dòng: thêm dòng lớn (không chỉ sửa total_amount) để điều chỉnh +1.000.000 vượt trần.
      await q(
        `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount)
         values ($1, $2, $3, 99, 'monthly', 'Lớn', 99999500000)`,
        [randomUUID(), A.tenantId, ha.id],
      );
      await q(`update invoices set total_amount = 99999500000 where id = $1`, [
        ha.id,
      ]);
      const res = await call(A, 'POST', `/invoices/${ha.id}/adjustments`, {
        amount: 1_000_000,
        description: 'x',
        adjustmentReason: 'y',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(res.json().errors.amount).toBeDefined();
      expect(
        await q(
          `select total_amount::bigint::text t from invoices where id = $1`,
          [ha.id],
        ),
      ).toEqual([{ t: '99999500000' }]);
    });

    it('AC-5: hóa đơn đã phát hành → 409 INVOICE_IMMUTABLE, tiền không đổi', async () => {
      const res = await call(A, 'POST', `/invoices/${draftBinh}/adjustments`, {
        amount: -1000,
        description: 'x',
        adjustmentReason: 'y',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVOICE_IMMUTABLE');
      expect(
        await q(`select total_amount::int from invoices where id = $1`, [
          draftBinh,
        ]),
      ).toEqual([{ total_amount: 900_000 }]);
    });
  });
  // Các test dưới chạy job ở ngày sau cùng nên đặt cuối: chúng tạo thêm kỳ cho mọi tenant đang có.
  it('S1: lỡ ngày chốt (hôm nay 10/02, ngày chốt 01/02) → kỳ 01/2027 vẫn được tạo; chạy lại hôm sau không tạo thêm', async () => {
    const C = await seedTenant(t.worker);
    const [cls, stu] = [randomUUID(), randomUUID()];
    await addClass(C, cls, 'C-Toán', ['monthly', 500_000, null]);
    await addStudent(C, stu, 'Cẩm');
    await enroll(C, cls, stu);
    expect(
      await job.run(new Date('2027-02-10T05:00:00Z')),
    ).toBeGreaterThanOrEqual(1);
    const [period] = await periodsOf(C);
    expect(period).toMatchObject({
      period_month: '2027-01-01',
      close_date: '2027-02-01',
      due_date: '2027-02-11',
    });
    expect((await invoicesOf(C)).map((i) => Number(i.total_amount))).toEqual([
      500_000,
    ]);
    await job.run(new Date('2027-02-11T05:00:00Z'));
    expect(await invoicesOf(C)).toHaveLength(1);
    expect(await periodsOf(C)).toHaveLength(1);
  });

  it('S3 (issue #179): học viên chuyển left/paused sau cuối kỳ (giữa ngày 1 và ngày chốt) vẫn bị tính kỳ M; left giữa kỳ chỉ tính buổi trước ngày rời; trigger ghi mốc', async () => {
    const H = await seedTenant(t.worker);
    await q(
      `update tenants set settings = '{"billingCloseDay": 5}' where id = $1`,
      [H.tenantId],
    );
    const [per, mon] = [randomUUID(), randomUUID()];
    await addClass(H, per, 'H-Toán', ['per_session', 100_000, null]);
    await addClass(H, mon, 'H-Văn', ['monthly', 400_000, null]);
    const [lateLeft, latePaused, midLeft, insertedLeft] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const [id, name] of [
      [lateLeft, 'Lan'],
      [latePaused, 'Mai'],
      [midLeft, 'Nga'],
      [insertedLeft, 'Oanh'],
    ] as const)
      await addStudent(H, id, name, name === 'Oanh' ? 'left' : 'active');
    for (const id of [lateLeft, midLeft, insertedLeft])
      await enroll(H, per, id);
    await enroll(H, mon, latePaused);
    for (const d of ['2026-12-10', '2026-12-25'])
      await q(
        `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5, $6, 'taught')`,
        [randomUUID(), H.tenantId, per, d, `${d}T11:00:00Z`, `${d}T12:00:00Z`],
      );
    await q(`update students set status = 'left' where id = any($1)`, [
      [lateLeft, midLeft],
    ]);
    await q(`update students set status = 'paused' where id = $1`, [
      latePaused,
    ]);
    // INSERT với status khác 'active' không có mốc (cách cũ: left không tính).

    expect(
      await q(
        `select full_name, status_before, status_changed_at is not null as has_at from students where tenant_id = $1 order by full_name`,
        [H.tenantId],
      ),
    ).toEqual([
      { full_name: 'Lan', status_before: 'active', has_at: true },
      { full_name: 'Mai', status_before: 'active', has_at: true },
      { full_name: 'Nga', status_before: 'active', has_at: true },
      { full_name: 'Oanh', status_before: null, has_at: false },
    ]);
    // Lan, Mai đổi trạng thái 03/01/2027 (sau kỳ 12/2026, trước ngày chốt 05/01); Nga rời 20/12/2026.
    await q(
      `update students set status_changed_at = '2027-01-03T03:00:00Z' where id = any($1)`,
      [[lateLeft, latePaused]],
    );
    await q(
      `update students set status_changed_at = '2026-12-20T03:00:00Z' where id = $1`,
      [midLeft],
    );
    await job.run(new Date('2027-01-04T19:00:00Z')); // 02:00 ngày 05/01/2027 giờ VN
    const totals = Object.fromEntries(
      (await invoicesOf(H)).map((i) => [i.full_name, Number(i.total_amount)]),
    );
    expect(totals).toEqual({ Lan: 200_000, Mai: 400_000, Nga: 100_000 });
  });

  it('S2: hai job chạy song song cùng lúc không sinh bản nháp trùng', async () => {
    const F = await seedTenant(t.worker);
    const [cls, stu] = [randomUUID(), randomUUID()];
    await addClass(F, cls, 'F-Toán', ['monthly', 300_000, null]);
    await addStudent(F, stu, 'Phúc');
    await enroll(F, cls, stu);
    const now = new Date('2027-02-28T19:00:00Z'); // 02:00 ngày 01/03/2027: kỳ 02/2027
    const [a, b] = await Promise.all([job.run(now), job.run(now)]);
    expect(await invoicesOf(F)).toHaveLength(1);
    expect(await periodsOf(F)).toHaveLength(1);
    // Tổng bản nháp hai lần chạy báo = số hóa đơn kỳ 02/2027 thực có; không (kỳ, học viên) nào có hai bản nháp.
    const [{ n }] = await q(
      `select count(*)::int n from invoices i join billing_periods p on p.id = i.period_id and p.tenant_id = i.tenant_id
        where p.period_month = '2027-02-01'`,
    );
    expect(a + b).toBe(n);
    expect(
      await q(
        `select 1 from invoices where status = 'draft' group by tenant_id, period_id, student_id having count(*) > 1`,
      ),
    ).toHaveLength(0);
  });

  it('S4 (issue #179): worker dừng hơn một tháng → job tạo đủ các kỳ thiếu cũ → mới; chạy lại không tạo thêm; kỳ cũ không bị bỏ', async () => {
    const J = await seedTenant(t.worker);
    const [cls, stu] = [randomUUID(), randomUUID()];
    await addClass(J, cls, 'J-Văn', ['monthly', 600_000, null]);
    await addStudent(J, stu, 'Quân');
    await enroll(J, cls, stu);
    // Kỳ đầu tiên 12/2026 chốt đúng hạn 01/01/2027, rồi worker dừng tới 10/03/2027 (kỳ 01 và 02/2027 đều đã quá ngày chốt).
    await job.run(new Date('2026-12-31T19:00:00Z'));
    expect((await periodsOf(J)).map((p) => p.period_month)).toEqual([
      '2026-12-01',
    ]);
    await job.run(new Date('2027-03-10T05:00:00Z'));
    const periods = await q(
      `select period_month::text m, close_date::text c, due_date::text d from billing_periods where tenant_id = $1 order by period_month`,
      [J.tenantId],
    );
    expect(periods).toEqual([
      { m: '2026-12-01', c: '2027-01-01', d: '2027-01-11' },
      { m: '2027-01-01', c: '2027-02-01', d: '2027-02-11' },
      { m: '2027-02-01', c: '2027-03-01', d: '2027-03-11' },
    ]);
    expect(await invoicesOf(J)).toHaveLength(3);
    await job.run(new Date('2027-03-11T05:00:00Z'));
    expect(await invoicesOf(J)).toHaveLength(3);
    expect(await periodsOf(J)).toHaveLength(3);
  });

  it('S5 (US-7.1 AC5, issue #179): khóa 24 buổi 3.600.000 đ, vào khi còn 16 buổi → 2.400.000 dù mới sinh 4 buổi cuốn chiếu', async () => {
    const K = await seedTenant(t.worker);
    const [cls, stu] = [randomUUID(), randomUUID()];
    // 24 buổi thứ Hai từ 04/01 đến 14/06/2027; vào lớp 01/03 là buổi thứ 9 → còn 16 buổi (từ 01/03).
    await q(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, end_date, fee_type, fee_amount)
       values ($1, $2, $3, 'K-Khóa', 'Toán', 9, 'online', '2027-01-04', '2027-06-14', 'course', 3600000)`,
      [cls, K.tenantId, K.branchId],
    );
    await q(
      `insert into schedule_rules (id, tenant_id, class_id, weekday, start_time, duration_min) values ($1, $2, $3, 1, '18:00', 90)`,
      [randomUUID(), K.tenantId, cls],
    );
    await addStudent(K, stu, 'Kiên');
    await q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, '2027-03-01')`,
      [randomUUID(), K.tenantId, cls, stu],
    );
    for (const d of ['2027-03-01', '2027-03-08', '2027-03-15', '2027-03-22'])
      await q(
        `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5, $6, 'taught')`,
        [randomUUID(), K.tenantId, cls, d, `${d}T11:00:00Z`, `${d}T12:30:00Z`],
      );
    await job.run(new Date('2027-03-31T19:00:00Z')); // 02:00 ngày 01/04/2027 giờ VN: kỳ 03/2027
    expect((await invoicesOf(K)).map((i) => Number(i.total_amount))).toEqual([
      2_400_000,
    ]);
  });
});
