import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { BillingCloseJob } from '../libs/modules/billing/application/billing-close.job.js';
import type { BillingReadyNotifier } from '../libs/modules/notifications/application/billing-ready-notifier.service.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

const CLOSE_A = new Date('2026-12-31T05:00:00Z'); // 12:00 ngày 31/12 giờ VN: ngày chốt mặc định (cuối tháng)
const CLOSE_B = new Date('2027-01-05T05:00:00Z'); // ngày chốt 5 của tenant B

// S5-BE-05 + S5-BE-06: job billing.close, API kỳ thu / hóa đơn / điều chỉnh, cô lập tenant.
describe('billing: job billing.close + API kỳ thu, hóa đơn, điều chỉnh', () => {
  let t: TestApp;
  let pool: pg.Pool;
  let job: BillingCloseJob;
  let notifier: BillingReadyNotifier;
  let pushed: {
    token: string;
    urgent: boolean;
    data: Record<string, string>;
  }[];
  let A: Who;
  let B: Who;
  const ids = {
    clsPer: randomUUID(),
    clsMonthly: randomUUID(),
    clsNoFee: randomUUID(),
    stu1: randomUUID(),
    stu2: randomUUID(),
    stu3: randomUUID(),
    stu4: randomUUID(),
    stu5: randomUUID(),
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
    [A, B] = [await mk(), await mk()];

    // Tenant A: lớp theo buổi (2 học viên + 1 tạm nghỉ + 1 đã rời), lớp theo tháng (stu1), lớp chưa có học phí (stu3).
    await addClass(A, ids.clsPer, 'Toán 9A', ['per_session', 150_000, null]);
    await addClass(A, ids.clsMonthly, 'Văn 9A', ['monthly', 1_000_000, null]);
    await addClass(A, ids.clsNoFee, 'Anh 9A', null);
    await addStudent(A, ids.stu1, 'An');
    await addStudent(A, ids.stu2, 'Bình');
    await addStudent(A, ids.stu3, 'Chi');
    await addStudent(A, ids.stu4, 'Dũng', 'paused');
    await addStudent(A, ids.stu5, 'Em');
    await enroll(A, ids.clsPer, ids.stu1);
    await enroll(A, ids.clsPer, ids.stu2, {
      override: { chargeExcused: false, chargeUnexcused: false, discounts: [] },
    });
    await enroll(A, ids.clsPer, ids.stu4);
    await enroll(A, ids.clsPer, ids.stu5, { leftOn: '2026-11-30' });
    await enroll(A, ids.clsMonthly, ids.stu1);
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
    await enroll(B, ids.clsB, ids.stuB);
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

  it('AC-1: ngày không phải ngày chốt → không tạo gì; đúng ngày chốt → kỳ + bản nháp đúng số tiền, lớp chưa có học phí/tạm nghỉ/đã rời bị bỏ', async () => {
    expect(await job.run(new Date('2026-12-30T05:00:00Z'))).toBe(0);
    expect(await periodsOf(A)).toHaveLength(0);

    expect(await job.run(CLOSE_A)).toBe(2); // tenant A (cuối tháng); B có ngày chốt 5 nên chưa tới
    const [period] = await periodsOf(A);
    expect(period).toMatchObject({
      period_month: '2026-12-01',
      close_date: '2026-12-31',
      due_date: '2027-01-10',
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
    const log = await q(
      `select status from job_runs where job = 'billing.close' order by started_at desc limit 1`,
    );
    expect(log[0].status).toBe('succeeded');
  });

  it('AC-2: chạy lại cùng ngày → không sinh bản nháp trùng, không ghi thêm outbox; học viên đã phát hành cũng không có bản nháp thứ hai', async () => {
    expect(await job.run(CLOSE_A)).toBe(0);
    expect(await invoicesOf(A)).toHaveLength(2);
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
    ]);
  });

  it('AC-3: ghi đúng một sự kiện outbox billing_drafts_ready cùng giao dịch; consumer tạo thông báo + push data-only cho chủ tenant, xử lý lại không gửi trùng', async () => {
    const [ev] = await q(
      `select id, payload from outbox_events where tenant_id = $1 and type = 'billing_drafts_ready'`,
      [A.tenantId],
    );
    const [period] = await periodsOf(A);
    expect(ev.payload).toEqual({
      periodId: period.id,
      periodMonth: '2026-12-01',
      draftCount: 2,
      draftTotalAmount: 3_100_000,
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
    expect(pushed[0]).toMatchObject({ token: 'tok-billing-a', urgent: false });
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
      period_month: '2027-01-01',
      close_date: '2027-01-05',
      due_date: '2027-01-15',
    });
    const invB = await invoicesOf(B);
    expect(invB.map((i) => [i.full_name, Number(i.total_amount)])).toEqual([
      ['Bảo', 700_000],
    ]);
    expect(await periodsOf(A)).toHaveLength(1);
    expect(await invoicesOf(A)).toHaveLength(2);
  });

  describe('API', () => {
    let periodA: string;
    let draftAn: string;
    let draftBinh: string;

    beforeAll(async () => {
      periodA = (await periodsOf(A))[0].id;
      // Dựng thêm một bản nháp cho Chi ở kỳ của A (lớp chưa học phí nên job không tạo) để có 3 hóa đơn: nháp, nháp, đã phát hành.
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
            closeDate: '2026-12-31',
            dueDate: '2027-01-10',
            status: 'drafting',
            draftCount: 1,
            issuedCount: 1,
            voidCount: 0,
            draftTotalAmount: 2_200_000,
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
      ).toEqual(['2027-01-01']);
    });

    it('AC-4: GET /billing-periods/{id}: tổng quan + hóa đơn sắp theo tên, lọc status, nhãn Giá riêng', async () => {
      const res = await call(A, 'GET', `/billing-periods/${periodA}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        id: periodA,
        draftCount: 1,
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
      ]);
      expect(body.invoices.total).toBe(2);
      const drafts = await call(
        A,
        'GET',
        `/billing-periods/${periodA}?status=draft&pageSize=1`,
      );
      expect(drafts.json().invoices).toMatchObject({ total: 1, pageSize: 1 });
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
        dueDate: '2027-01-10',
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
});
