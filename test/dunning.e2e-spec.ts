import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { DunningJob } from '../libs/modules/billing/application/dunning.job.js';
import { addDays } from '../libs/modules/billing/domain/billing-period.js';
import {
  localDate,
  zonedToInstant,
} from '../libs/modules/schedule/domain/zoned-time.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };
interface Step {
  offsetDays: number;
  scheduledFor: string;
  status: 'pending' | 'sent' | 'cancelled';
  sentAt: string | null;
}
interface InvDunning {
  invoiceId: string;
  enabled: boolean;
  disabledReason: string | null;
  steps: Step[];
}
interface EnrDunning {
  enrollmentId: string;
  studentId: string;
  enabled: boolean;
  studentDunningEnabled: boolean;
  cancelledCount: number;
}

const TZ = 'Asia/Ho_Chi_Minh';
const today = localDate(new Date(), TZ);
/** Thời điểm `hh:mm` (giờ VN) của ngày `date`. */
const at = (date: string, hhmm: string) => zonedToInstant(date, hhmm, TZ);

// S6-BE-04: nhắc nợ (US-7.5 AC1–AC4, DoD 6.4/6.7). Hóa đơn phát hành thật qua API; job chạy với `now` giả lập (không đổi đồng hồ máy).
describe('dunning: nhắc nợ tự động', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;
  let job: DunningJob;
  let jobPool: pg.Pool;
  let seq = 0;

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    who: { token: string },
    method: 'GET' | 'POST' | 'PUT',
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
  const put = async <T>(
    who: { token: string },
    url: string,
    body: object,
  ): Promise<T> => {
    const r = await call(who, 'PUT', url, body);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as T;
  };

  /** Kỳ riêng (hạn thanh toán = hôm nay + `dueIn` ngày) + một học viên + một hóa đơn nháp, rồi phát hành qua API. */
  const mkIssued = async (
    who: Who,
    opts: { dueIn?: number; total?: number; studentId?: string } = {},
  ) => {
    const { dueIn = 10, total = 1_000_000 } = opts;
    seq++;
    const month = `${2041 + Math.floor(seq / 12)}-${String((seq % 12) + 1).padStart(2, '0')}-01`;
    const due = addDays(today, dueIn);
    const studentId = opts.studentId ?? randomUUID();
    if (!opts.studentId)
      await q(
        `insert into students (id, tenant_id, full_name) values ($1, $2, 'Lê Gia Bảo')`,
        [studentId, who.tenantId],
      );
    const periodId = randomUUID();
    const invoiceId = randomUUID();
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $3, $4)`,
      [periodId, who.tenantId, month, due],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [invoiceId, who.tenantId, periodId, studentId, total],
    );
    if (total > 0)
      await q(
        `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount) values ($1, $2, $3, 1, 'monthly', 'Học phí tháng', $4)`,
        [randomUUID(), who.tenantId, invoiceId, total],
      );
    await issue(who, periodId);
    return { invoiceId, studentId, periodId, due };
  };
  const issue = async (who: Who, periodId: string) => {
    const r = await call(who, 'POST', `/billing-periods/${periodId}/issue`, {
      invoiceIds: null,
    });
    expect(r.statusCode, r.body).toBe(200);
  };
  const steps = (invoiceId: string) =>
    q(
      `select offset_days, status, cancel_reason, scheduled_for, sent_at from dunning_jobs where invoice_id = $1 order by offset_days`,
      [invoiceId],
    );
  const statuses = async (invoiceId: string) =>
    Object.fromEntries(
      (await steps(invoiceId)).map((s) => [s.offset_days, s.status]),
    );
  const reminders = (invoiceId: string) =>
    q(
      `select id, payload from outbox_events where type = 'payment_reminder' and payload->>'invoiceId' = $1 order by created_at`,
      [invoiceId],
    );
  /** Chạy job tại `now`; trả số lời nhắc MỚI của riêng `invoiceId` (job quét mọi tenant nên không dựa vào tổng). */
  const sentFor = async (invoiceId: string, now: Date) => {
    const before = (await reminders(invoiceId)).length;
    await job.run(now);
    return (await reminders(invoiceId)).length - before;
  };
  const pay = (who: Who, invoiceId: string, amount: number) =>
    call(who, 'POST', `/invoices/${invoiceId}/payments`, {
      amount,
      method: 'cash',
    });
  const addEnrollment = async (who: Who, studentId: string) => {
    const classId = randomUUID();
    const id = randomUUID();
    await q(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, fee_type, fee_amount)
       values ($1, $2, $3, 'Lớp thử', 'Toán', 9, 'online', '2026-11-01', 'monthly', 100000)`,
      [classId, who.tenantId, who.branchId],
    );
    await q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, '2026-11-01')`,
      [id, who.tenantId, classId, studentId],
    );
    return id;
  };

  beforeAll(async () => {
    t = await startTestApp();
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    const { DunningJob } =
      await import('../libs/modules/billing/application/dunning.job.js');
    jobPool = new pg.Pool({
      connectionString: t.db.url('teachhub_worker'),
    });
    const tx = new TxService(
      drizzle(jobPool, { schema, casing: 'snake_case' }),
    );
    job = new DunningJob(tx, new JobRuns(tx));
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      await q(
        `insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary) values ($1, $2, '970436', '0011223344', 'GV', true)`,
        [randomUUID(), s.tenantId],
      );
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
  }, 60_000);
  afterAll(async () => {
    await jobPool?.end();
    await t?.stop();
  });

  it('AC1 (US-7.5): phát hành → lập d−1, d0, d+3, d+7 lúc 09:00 giờ tenant; hóa đơn 0 đ không có lịch', async () => {
    const { invoiceId, due } = await mkIssued(A);
    const view = await get<InvDunning>(A, `/invoices/${invoiceId}/dunning`);
    expect(view).toMatchObject({ enabled: true, disabledReason: null });
    expect(view.steps.map((s) => [s.offsetDays, s.status, s.sentAt])).toEqual([
      [-1, 'pending', null],
      [0, 'pending', null],
      [3, 'pending', null],
      [7, 'pending', null],
    ]);
    expect(view.steps[0]!.scheduledFor).toBe(
      `${addDays(due, -1)}T09:00:00+07:00`,
    );
    expect(view.steps[3]!.scheduledFor).toBe(
      `${addDays(due, 7)}T09:00:00+07:00`,
    );

    // Hóa đơn 0 đ không phát hành được (giữ nháp), nên không có lịch; bản nháp trả steps rỗng.
    const zero = await mkIssuedDraftOnly(A, 0);
    expect(
      (await get<InvDunning>(A, `/invoices/${zero}/dunning`)).steps,
    ).toEqual([]);
    expect(
      await q(`select 1 from dunning_jobs where invoice_id = $1`, [zero]),
    ).toHaveLength(0);
  });

  /** Chỉ dựng hóa đơn nháp (không phát hành). */
  const mkIssuedDraftOnly = async (who: Who, total: number) => {
    seq++;
    const periodId = randomUUID();
    const invoiceId = randomUUID();
    const studentId = randomUUID();
    await q(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'HS')`,
      [studentId, who.tenantId],
    );
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $3, $3)`,
      [periodId, who.tenantId, `${2060 + seq}-01-01`],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [invoiceId, who.tenantId, periodId, studentId, total],
    );
    return invoiceId;
  };

  it('bỏ mốc đã qua: hóa đơn hạn cách đây 2 ngày chỉ còn d+3 và d+7', async () => {
    const { invoiceId } = await mkIssued(A, { dueIn: -2 });
    expect(await statuses(invoiceId)).toEqual({ 3: 'pending', 7: 'pending' });
  });

  it('AC1: job gửi đúng ngày 9, 10, 13, 17 (hạn ngày 10), chạy lại cùng lúc không nhắc trùng', async () => {
    const { invoiceId, studentId, due } = await mkIssued(A, {
      total: 1_200_000,
    });
    const day = (offset: number, hhmm = '09:05') =>
      at(addDays(due, offset), hhmm);

    expect(await sentFor(invoiceId, day(-2))).toBe(0);
    expect(await sentFor(invoiceId, day(-1))).toBe(1);
    expect(await job.run(day(-1))).toBe(0); // chạy lần 2: không nhắc trùng
    expect(await reminders(invoiceId)).toHaveLength(1);
    expect((await reminders(invoiceId))[0]!.payload).toEqual({
      invoiceId,
      studentId,
      offsetDays: -1,
      remainingAmount: 1_200_000,
      dueDate: due,
    });
    for (const offset of [0, 3, 7]) {
      expect(await sentFor(invoiceId, day(offset)), `d${offset}`).toBe(1);
      expect(await job.run(day(offset))).toBe(0);
    }
    expect(
      (await reminders(invoiceId)).map((r) => r.payload.offsetDays),
    ).toEqual([-1, 0, 3, 7]);
    expect(await statuses(invoiceId)).toEqual({
      '-1': 'sent',
      0: 'sent',
      3: 'sent',
      7: 'sent',
    });
    const view = await get<InvDunning>(A, `/invoices/${invoiceId}/dunning`);
    expect(view.steps.every((s) => s.sentAt !== null)).toBe(true);
  });

  it('khung giờ: ngoài 07:00–21:30 không gửi, dồn sang khung kế; không dội nhiều tin khi bỏ lỡ nhiều mốc', async () => {
    const { invoiceId, due } = await mkIssued(A);
    // Mốc d−1 (09:00 ngày trước hạn) đã tới ở mọi thời điểm dưới đây nhưng ngoài khung 07:00–21:30 thì không gửi.
    expect(await sentFor(invoiceId, at(addDays(due, -1), '21:31'))).toBe(0);
    expect(await sentFor(invoiceId, at(addDays(due, -1), '23:00'))).toBe(0);
    expect(await sentFor(invoiceId, at(due, '06:59'))).toBe(0);
    expect(await statuses(invoiceId)).toMatchObject({ '-1': 'pending' });
    // Ngày hạn 09:00: d−1 (dồn từ khung trước) và d0 đều đã tới → chỉ gửi mốc muộn nhất, mốc sớm bị bỏ qua.
    expect(await sentFor(invoiceId, at(due, '09:00'))).toBe(1);
    expect(await statuses(invoiceId)).toMatchObject({
      '-1': 'cancelled',
      0: 'sent',
    });
    expect(
      (await steps(invoiceId)).find((s) => s.offset_days === -1)?.cancel_reason,
    ).toBe('superseded');
    // 21:30 vẫn trong khung.
    expect(await sentFor(invoiceId, at(addDays(due, 3), '21:30'))).toBe(1);
  });

  it('AC2: thu đủ → dunningCancelled, mốc chưa gửi bị hủy, job không gửi nữa; thu một phần vẫn nhắc số còn lại', async () => {
    const part = await mkIssued(A, { total: 1_000_000 });
    const p1 = await pay(A, part.invoiceId, 400_000);
    expect(p1.json().dunningCancelled).toBe(false);
    expect(await statuses(part.invoiceId)).toEqual({
      '-1': 'pending',
      0: 'pending',
      3: 'pending',
      7: 'pending',
    });
    expect(
      await sentFor(part.invoiceId, at(addDays(part.due, -1), '09:05')),
    ).toBe(1);
    expect((await reminders(part.invoiceId))[0]!.payload.remainingAmount).toBe(
      600_000,
    );

    const p2 = await pay(A, part.invoiceId, 600_000);
    expect(p2.json()).toMatchObject({ status: 'paid', dunningCancelled: true });
    expect(await statuses(part.invoiceId)).toEqual({
      '-1': 'sent',
      0: 'cancelled',
      3: 'cancelled',
      7: 'cancelled',
    });
    expect(await sentFor(part.invoiceId, at(part.due, '09:05'))).toBe(0);
    expect(
      await sentFor(part.invoiceId, at(addDays(part.due, 7), '09:05')),
    ).toBe(0);
    expect(
      (await get<InvDunning>(A, `/invoices/${part.invoiceId}/dunning`))
        .disabledReason,
    ).toBe('paid');
  });

  it('hủy thanh toán làm hóa đơn còn nợ lại → lập lại các mốc chưa qua (mốc đã qua giữ hủy)', async () => {
    const { invoiceId } = await mkIssued(A, { dueIn: -2 }); // chỉ d+3, d+7
    const paid = (await pay(A, invoiceId, 1_000_000)).json();
    expect(paid.dunningCancelled).toBe(true);
    expect(await statuses(invoiceId)).toEqual({
      3: 'cancelled',
      7: 'cancelled',
    });
    const voided = await call(A, 'POST', `/payments/${paid.payment.id}/void`, {
      reason: 'nhập nhầm',
    });
    expect(voided.json().dunningCancelled).toBe(false);
    expect(await statuses(invoiceId)).toEqual({ 3: 'pending', 7: 'pending' });
    // Thu đủ lại rồi hủy lại vẫn lập lại, không sinh dòng mới.
    const again = (await pay(A, invoiceId, 1_000_000)).json();
    await call(A, 'POST', `/payments/${again.payment.id}/void`, {
      reason: 'lại nhầm',
    });
    expect(await steps(invoiceId)).toHaveLength(2);
    expect(await statuses(invoiceId)).toEqual({ 3: 'pending', 7: 'pending' });
  });

  it('hủy hóa đơn → hủy mốc còn lại', async () => {
    const { invoiceId } = await mkIssued(A);
    const r = await call(A, 'POST', `/invoices/${invoiceId}/void`, {
      reason: 'phát hành nhầm',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await statuses(invoiceId)).toEqual({
      '-1': 'cancelled',
      0: 'cancelled',
      3: 'cancelled',
      7: 'cancelled',
    });
    expect(
      await get<InvDunning>(A, `/invoices/${invoiceId}/dunning`),
    ).toMatchObject({ enabled: false, disabledReason: 'void' });
  });

  it('nợ chuyển sang hóa đơn kỳ sau → hóa đơn cũ hết nhắc, hóa đơn mới có lịch riêng', async () => {
    const old = await mkIssued(A, { dueIn: 5 });
    expect(Object.values(await statuses(old.invoiceId))).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    // Kỳ kế tiếp của cùng học viên (tháng sau) với một khoản phát sinh mới.
    const periodId = randomUUID();
    const invoiceId = randomUUID();
    const m = '2099-01-01'; // muộn hơn mọi kỳ dựng bằng `mkIssued`
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $3, $4)`,
      [periodId, A.tenantId, m, addDays(today, 40)],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 500000)`,
      [invoiceId, A.tenantId, periodId, old.studentId],
    );
    await q(
      `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount) values ($1, $2, $3, 1, 'monthly', 'Học phí tháng', 500000)`,
      [randomUUID(), A.tenantId, invoiceId],
    );
    await issue(A, periodId);
    const [row] = await q(
      `select carried_amount::int c, total_amount::int total from invoices where id = $1`,
      [old.invoiceId],
    );
    expect(row.c).toBe(1_000_000);
    expect(await statuses(old.invoiceId)).toEqual({
      '-1': 'cancelled',
      0: 'cancelled',
      3: 'cancelled',
      7: 'cancelled',
    });
    expect(
      (await steps(old.invoiceId)).every((s) => s.cancel_reason === 'settled'),
    ).toBe(true);
    const fresh = await get<InvDunning>(A, `/invoices/${invoiceId}/dunning`);
    expect(fresh.steps).toHaveLength(4);
    expect(fresh.steps.every((s) => s.status === 'pending')).toBe(true);
    // Nhắc hóa đơn mới tính cả khoản nợ cũ đã chuyển vào (nợ thật của hóa đơn mới).
    const [{ total }] = await q(
      `select total_amount::int total from invoices where id = $1`,
      [invoiceId],
    );
    expect(total).toBe(1_500_000);
    const firstDue = addDays(addDays(today, 40), -1);
    expect(await sentFor(invoiceId, at(firstDue, '09:05'))).toBe(1);
    expect(await reminders(old.invoiceId)).toHaveLength(0);
    expect((await reminders(invoiceId))[0]!.payload.remainingAmount).toBe(
      1_500_000,
    );
  });

  it('AC3: tắt nhắc theo học viên chỉ khi MỌI ghi danh mở đều tắt; bật lại lập lại; gọi lặp không đổi gì', async () => {
    const { invoiceId, studentId, due } = await mkIssued(A);
    const e1 = await addEnrollment(A, studentId);
    const e2 = await addEnrollment(A, studentId);
    const off1 = await put<EnrDunning>(A, `/enrollments/${e1}/dunning`, {
      enabled: false,
    });
    expect(off1).toMatchObject({
      enrollmentId: e1,
      studentId,
      enabled: false,
      studentDunningEnabled: true,
      cancelledCount: 0,
    });
    expect(Object.values(await statuses(invoiceId))).toEqual(
      Array(4).fill('pending'),
    );

    const off2 = await put<EnrDunning>(A, `/enrollments/${e2}/dunning`, {
      enabled: false,
    });
    expect(off2).toMatchObject({
      studentDunningEnabled: false,
      cancelledCount: 4,
    });
    expect(await statuses(invoiceId)).toEqual({
      '-1': 'cancelled',
      0: 'cancelled',
      3: 'cancelled',
      7: 'cancelled',
    });
    expect(
      await get<InvDunning>(A, `/invoices/${invoiceId}/dunning`),
    ).toMatchObject({ enabled: false, disabledReason: 'student_disabled' });
    expect(await sentFor(invoiceId, at(addDays(due, 7), '09:05'))).toBe(0);
    const again = await put<EnrDunning>(A, `/enrollments/${e2}/dunning`, {
      enabled: false,
    });
    expect(again).toMatchObject({
      studentDunningEnabled: false,
      cancelledCount: 0,
    });

    // Công nợ của học viên phản ánh công tắc thật.
    const hist = await get<{
      dunningEnabled: boolean;
      enrollments: { enrollmentId: string; dunningEnabled: boolean }[];
      reminders: Step[];
    }>(A, `/receivables/${studentId}`);
    expect(hist.dunningEnabled).toBe(false);
    expect(hist.enrollments.map((e) => e.dunningEnabled)).toEqual([
      false,
      false,
    ]);
    expect(hist.reminders.every((r) => r.status === 'cancelled')).toBe(true);

    const on = await put<EnrDunning>(A, `/enrollments/${e1}/dunning`, {
      enabled: true,
    });
    expect(on).toMatchObject({
      studentDunningEnabled: true,
      cancelledCount: 0,
    });
    expect(Object.values(await statuses(invoiceId))).toEqual(
      Array(4).fill('pending'),
    );
    expect(await sentFor(invoiceId, at(addDays(due, -1), '09:05'))).toBe(1);
  });

  it('US-7.5 AC4 / lịch: PUT settings đổi lịch cho hóa đơn phát hành sau; preview là tin mẫu của hệ thống', async () => {
    expect(await get(A, '/tenant/settings/dunning')).toEqual({
      enabled: true,
      offsetsDays: [-1, 0, 3, 7],
    });
    const before = await mkIssued(A);
    const saved = await put(A, '/tenant/settings/dunning', {
      enabled: true,
      offsetsDays: [0, 5],
    });
    expect(saved).toEqual({ enabled: true, offsetsDays: [0, 5] });
    expect(await get(A, '/tenant/settings/dunning')).toEqual(saved);
    expect(Object.keys(await statuses(before.invoiceId))).toHaveLength(4); // hóa đơn cũ giữ lịch cũ
    const after = await mkIssued(A);
    expect(await statuses(after.invoiceId)).toEqual({
      0: 'pending',
      5: 'pending',
    });
    await put(A, '/tenant/settings/dunning', {
      enabled: true,
      offsetsDays: [-1, 0, 3, 7],
    });

    const pv = await get<{ offsetDays: number; title: string; body: string }>(
      A,
      '/tenant/settings/dunning/preview?offsetDays=3',
    );
    expect(pv.offsetDays).toBe(3);
    expect(pv.body).toMatch(
      /^DayHoc nhắc: .*quá hạn 3 ngày.*còn nợ 700\.000 đ/,
    );
    for (const bad of [
      { enabled: true, offsetsDays: [3, 0] },
      { enabled: true, offsetsDays: [0, 0] },
      { enabled: true, offsetsDays: [] },
      { enabled: true, offsetsDays: [-8] },
      { enabled: true, offsetsDays: [0, 1, 2, 3, 4, 5, 6] },
      { enabled: 'yes', offsetsDays: [0] },
    ])
      expect(
        (await call(A, 'PUT', '/tenant/settings/dunning', bad)).statusCode,
      ).toBe(422);
    expect(
      (await call(A, 'GET', '/tenant/settings/dunning/preview?offsetDays=99'))
        .statusCode,
    ).toBe(422);
  });

  it('tenant tắt nhắc: hủy mốc chưa gửi của mọi hóa đơn, hóa đơn mới không có lịch; bật lại không lập cho hóa đơn cũ', async () => {
    const old = await mkIssued(B);
    await put(B, '/tenant/settings/dunning', {
      enabled: false,
      offsetsDays: [-1, 0, 3, 7],
    });
    expect(await statuses(old.invoiceId)).toEqual({
      '-1': 'cancelled',
      0: 'cancelled',
      3: 'cancelled',
      7: 'cancelled',
    });
    expect(
      await get<InvDunning>(B, `/invoices/${old.invoiceId}/dunning`),
    ).toMatchObject({ enabled: false, disabledReason: 'tenant_disabled' });
    const fresh = await mkIssued(B);
    expect(await steps(fresh.invoiceId)).toHaveLength(0);
    expect(await sentFor(old.invoiceId, at(addDays(old.due, 7), '09:05'))).toBe(
      0,
    );
    await put(B, '/tenant/settings/dunning', {
      enabled: true,
      offsetsDays: [-1, 0, 3, 7],
    });
    expect(Object.values(await statuses(old.invoiceId))).toEqual(
      Array(4).fill('cancelled'),
    );
    expect((await mkIssued(B)).invoiceId).toBeTruthy();
  });

  it('DoD 6.4: chỉ chủ tenant; 404 chéo tenant; id lạ 404; ghi danh đã rời 409; RLS: B không thấy dunning_jobs của A', async () => {
    const { invoiceId, studentId } = await mkIssued(A);
    const enr = await addEnrollment(A, studentId);
    const teacher = {
      token: await t.tokenFor(
        await seedMember(t.worker, A.tenantId, 'teacher'),
      ),
    };
    for (const [method, url, body] of [
      ['GET', '/tenant/settings/dunning', undefined],
      ['PUT', '/tenant/settings/dunning', { enabled: true, offsetsDays: [0] }],
      ['GET', '/tenant/settings/dunning/preview?offsetDays=0', undefined],
      ['PUT', `/enrollments/${enr}/dunning`, { enabled: false }],
      ['GET', `/invoices/${invoiceId}/dunning`, undefined],
    ] as const)
      expect((await call(teacher, method, url, body)).statusCode, url).toBe(
        403,
      );

    expect(
      (await call(B, 'GET', `/invoices/${invoiceId}/dunning`)).statusCode,
    ).toBe(404);
    expect(
      (await call(B, 'GET', `/invoices/${randomUUID()}/dunning`)).statusCode,
    ).toBe(404);
    expect(
      (await call(B, 'PUT', `/enrollments/${enr}/dunning`, { enabled: false }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(A, 'PUT', `/enrollments/${randomUUID()}/dunning`, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await q(`select dunning_enabled from enrollments where id = $1`, [enr])
      )[0].dunning_enabled,
    ).toBe(true);
    expect((await call(B, 'GET', `/receivables/${studentId}`)).statusCode).toBe(
      404,
    );

    await q(`update enrollments set left_on = '2026-12-01' where id = $1`, [
      enr,
    ]);
    expect(
      (await call(A, 'PUT', `/enrollments/${enr}/dunning`, { enabled: false }))
        .statusCode,
    ).toBe(409);

    const app = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [
        B.userId,
      ]);
      expect(
        (
          await client.query(
            `select count(*)::int n from dunning_jobs where tenant_id = $1`,
            [A.tenantId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await client.query(
            `update dunning_jobs set status = 'cancelled', cancel_reason = 'void' where tenant_id = $1`,
            [A.tenantId],
          )
        ).rowCount,
      ).toBe(0);
      await client.query('rollback');
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [
        A.userId,
      ]);
      expect(
        (
          await client.query(
            `select count(*)::int n from dunning_jobs where invoice_id = $1`,
            [invoiceId],
          )
        ).rows[0].n,
      ).toBe(4);
      await expect(
        client.query(`delete from dunning_jobs where invoice_id = $1`, [
          invoiceId,
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await app.end();
    }
  });

  it('worker lọc theo tenant: job chỉ gửi nhắc của đúng hóa đơn đến hạn, không đụng hóa đơn tenant khác', async () => {
    const a = await mkIssued(A);
    const b = await mkIssued(B);
    await put(B, '/tenant/settings/dunning', {
      enabled: true,
      offsetsDays: [-1, 0, 3, 7],
    });
    const now = at(addDays(a.due, -1), '09:05');
    await job.run(now);
    expect((await reminders(a.invoiceId)).length).toBe(1);
    expect((await reminders(b.invoiceId)).length).toBe(1);
    const events = await q(
      `select tenant_id from outbox_events where type = 'payment_reminder' and payload->>'invoiceId' = any($1)`,
      [[a.invoiceId, b.invoiceId]],
    );
    expect(new Set(events.map((e) => e.tenant_id))).toEqual(
      new Set([A.tenantId, B.tenantId]),
    );
  });

  it('consumer payment_reminder: thông báo trong app có số còn nợ và hạn, push chữ chung không số tiền, email có số tiền; gửi lặp không trùng', async () => {
    const { PaymentReminderNotifier } =
      await import('../libs/modules/notifications/application/payment-reminder-notifier.service.js');
    const { AbsenceNotifier } =
      await import('../libs/modules/notifications/application/absence-notifier.service.js');
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const pushed: {
      copy: { title: string; body: string };
      data: Record<string, string>;
    }[] = [];
    const mails: { to: string; subject: string; text: string }[] = [];
    const notifier = new PaymentReminderNotifier(
      new TxService(drizzle(jobPool, { schema, casing: 'snake_case' })),
      new AbsenceNotifier(
        new TxService(drizzle(jobPool, { schema, casing: 'snake_case' })),
        {
          enabled: true,
          send: (ms: typeof pushed) => {
            pushed.push(...ms);
            return Promise.resolve(
              ms.map(() => ({ ok: true as const, messageId: 'm' })),
            );
          },
        } as never,
      ),
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
    const { invoiceId, studentId, due } = await mkIssued(A, {
      total: 1_200_000,
    });
    await q(
      `insert into guardians (id, tenant_id, student_id, full_name, email, user_id) values ($1, $2, $3, 'PH', 'ph@example.com', $4)`,
      [randomUUID(), A.tenantId, studentId, parent],
    );
    await pay(A, invoiceId, 200_000);
    await job.run(at(addDays(due, 3), '09:05'));
    const [ev] = await reminders(invoiceId);
    const jobData = {
      eventId: ev!.id,
      tenantId: A.tenantId,
      payload: ev!.payload,
    };
    await notifier.handle(jobData);
    await notifier.handle(jobData);
    const notes = await q(
      `select type, urgency, payload from notifications where recipient_user_id = $1`,
      [parent],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: 'payment_reminder',
      urgency: 'normal',
    });
    expect(notes[0].payload).toEqual({
      invoiceId,
      studentId,
      studentName: 'Lê Gia Bảo',
      offsetDays: 3,
      remainingAmount: 1_000_000,
      dueDate: due,
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.copy.title).toBe('DayHoc nhắc học phí');
    expect(JSON.stringify(pushed)).not.toMatch(
      /Lê Gia Bảo|1000000|1\.000\.000/,
    );
    expect(Object.keys(pushed[0]!.data).sort()).toEqual([
      'notificationId',
      'type',
    ]);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('ph@example.com');
    expect(mails[0]!.subject).toBe('DayHoc nhắc học phí');
    expect(mails[0]!.text).toContain('DayHoc nhắc');
    expect(mails[0]!.text).toContain('1.000.000 đ');
    expect(mails[0]!.text).not.toContain('Lê Gia Bảo');
  });

  it('thanh toán và nhắc nợ không phá đối soát: Σ paid_amount = Σ payments còn hiệu lực', async () => {
    const [r] = await q(
      `select (select coalesce(sum(amount), 0)::bigint from payments where tenant_id = $1 and voided_at is null) as p,
              (select coalesce(sum(paid_amount), 0)::bigint from invoices where tenant_id = $1) as i`,
      [A.tenantId],
    );
    expect(Number(r.p)).toBe(Number(r.i));
  });
});
