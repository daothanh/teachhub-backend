import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { startTestS3, type TestS3 } from './containers.js';
import { startTestApp, type TestApp } from './support/app.js';
import {
  familyFixture,
  type Child,
  type Parent,
  type Teacher,
} from './support/family-fixture.js';

type Claim = {
  id: string;
  invoiceId: string;
  status: string;
  amount: number;
  note: string | null;
  receiptFileId: string;
  claimedBy: { id: string; name: string };
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  rejectReason: string | null;
  paymentId: string | null;
};
type Resolved = {
  claim: Claim;
  result: {
    payment: { id: string; method: string; amount: number };
    status: string;
    paidAmount: number;
    remainingAmount: number;
  } | null;
};

const TOTAL = 1_200_000;

// S8-BE claims: phụ huynh báo đã chuyển khoản, giáo viên xác nhận / "chưa nhận được" (US-7.7).
describe('payment_claims: báo đã chuyển khoản (US-7.7)', () => {
  let t: TestApp;
  let s3: TestS3;
  let appPool: pg.Pool;
  let f: ReturnType<typeof familyFixture>;
  let A: Teacher;
  let B: Teacher;
  let P1: Parent;
  let P2: Parent;
  let P3: Parent;
  let c1: Child;
  let c2: Child;
  let c3: Child;

  const q = (sql: string, params: unknown[] = []) => f.q(sql, params);
  const claim = (
    p: Parent,
    invoiceId: string,
    body: object,
    key?: string | null,
  ) =>
    f.call(
      p.token,
      'POST',
      `/family/invoices/${invoiceId}/payment-claims`,
      body,
      key,
    );
  const resolve = (
    who: { token: string },
    claimId: string,
    body: object,
    key?: string | null,
  ) =>
    f.call(who.token, 'POST', `/payment-claims/${claimId}/resolve`, body, key);
  /** Hóa đơn của `c` kèm biên lai `ready` của `p` (dựng thẳng DB, không cần kho S3). */
  const setup = async (c: Child, p: Parent, o: { total?: number } = {}) => {
    const invoiceId = await f.invoice(c, o);
    const receiptFileId = await f.dbFile({
      tenantId: c.who.tenantId,
      ownerUserId: p.userId,
      entityId: invoiceId,
    });
    return { invoiceId, receiptFileId };
  };
  const inv = async (id: string) =>
    (await q(`select * from invoices where id = $1`, [id]))[0];
  const dunning = async (invoiceId: string) =>
    await q(
      `select offset_days, status, cancel_reason from dunning_jobs where invoice_id = $1 order by offset_days`,
      [invoiceId],
    );
  /** Ba mốc nhắc nợ chưa tới của hóa đơn (như lúc phát hành). */
  const seedDunning = async (c: Child, invoiceId: string) => {
    for (const [i, off] of [-1, 0, 3].entries())
      await q(
        `insert into dunning_jobs (id, tenant_id, invoice_id, offset_days, scheduled_for)
         values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [randomUUID(), c.who.tenantId, invoiceId, off, 5 + i],
      );
  };
  const outbox = async (type: string, invoiceId: string) =>
    await q(
      `select tenant_id, payload from outbox_events where type = $1 and payload->>'invoiceId' = $2 order by created_at`,
      [type, invoiceId],
    );
  const payments = async (invoiceId: string) =>
    await q(
      `select id, amount, method, voided_at from payments where invoice_id = $1`,
      [invoiceId],
    );
  const sums = async (tenantId: string) => {
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
  const reconcileMismatches = async () => {
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    const { BillingReconcileJob } =
      await import('../libs/modules/billing/application/billing-reconcile.job.js');
    const tx = new TxService(
      drizzle(t.worker, { schema, casing: 'snake_case' }),
    );
    const job = new BillingReconcileJob(tx, new JobRuns(tx), {
      get: () => undefined,
    } as never);
    return job.run();
  };
  const asUser = async <T>(
    userId: string,
    sql: string,
    args: unknown[] = [],
  ) => {
    const c = await appPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [userId]);
      const r = await c.query(sql, args);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };

  beforeAll(async () => {
    s3 = await startTestS3();
    t = await startTestApp(s3.env);
    appPool = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    f = familyFixture(t, {
      client: new S3Client({
        endpoint: s3.env.S3_ENDPOINT,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: s3.env.S3_ACCESS_KEY_ID!,
          secretAccessKey: s3.env.S3_SECRET_ACCESS_KEY!,
        },
      }),
      bucket: s3.env.S3_BUCKET_PRIVATE!,
    });
    A = await f.mkTeacher('Cô Lan');
    B = await f.mkTeacher('Thầy Bình');
    P1 = await f.mkParent(true, 'Nguyễn Văn Hải');
    P2 = await f.mkParent(true, 'Phụ huynh Hai');
    P3 = await f.mkParent(true, 'Phụ huynh Ba');
    c1 = await f.child(A, P1);
    c2 = await f.child(A, P2, 'Trần Minh');
    c3 = await f.child(B, P3, 'Phạm Vy');
  }, 240_000);
  afterAll(async () => {
    await appPool?.end();
    await t?.stop();
    await s3?.container.stop();
  });

  it('AC1 luồng đủ với kho S3 thật: tải biên lai → báo → hóa đơn chờ xác nhận, nhắc nợ tạm dừng, outbox, audit; giáo viên xem biên lai', async () => {
    const invoiceId = await f.invoice(c1);
    await seedDunning(c1, invoiceId);
    const fileId = await f.uploadReceipt(P1, invoiceId);

    const res = await claim(P1, invoiceId, {
      receiptFileId: fileId,
      note: 'Chuyển lúc 9h sáng, ACB',
    });
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as Claim;
    expect(c).toMatchObject({
      invoiceId,
      status: 'pending',
      amount: TOTAL,
      note: 'Chuyển lúc 9h sáng, ACB',
      receiptFileId: fileId,
      claimedBy: { id: P1.userId, name: 'Nguyễn Văn Hải' },
      resolvedAt: null,
      resolvedBy: null,
      rejectReason: null,
      paymentId: null,
    });
    expect(c.createdAt).toMatch(/\+07:00$/);

    expect((await inv(invoiceId)).status).toBe('pending_confirmation');
    expect(await dunning(invoiceId)).toEqual([
      { offset_days: -1, status: 'cancelled', cancel_reason: 'claim_pending' },
      { offset_days: 0, status: 'cancelled', cancel_reason: 'claim_pending' },
      { offset_days: 3, status: 'cancelled', cancel_reason: 'claim_pending' },
    ]);
    const ev = await outbox('payment_claim_created', invoiceId);
    expect(ev).toHaveLength(1);
    expect(ev[0].tenant_id).toBe(A.tenantId);
    expect(ev[0].payload).toEqual({ claimId: c.id, invoiceId });
    const audit = await q(
      `select actor_user_id, action from audit_logs where entity = 'payment_claims' and entity_id = $1`,
      [c.id],
    );
    expect(audit).toEqual([{ actor_user_id: P1.userId, action: 'insert' }]);

    const list = await f.call(
      A.token,
      'GET',
      `/invoices/${invoiceId}/payment-claims`,
    );
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { items: Claim[] }).items).toEqual([c]);
    const dl = await f.call(A.token, 'GET', `/files/${fileId}/download-url`);
    expect(dl.statusCode, dl.body).toBe(200);
    expect(
      (await f.call(P2.token, 'GET', `/files/${fileId}/download-url`))
        .statusCode,
    ).toBe(404);
    expect(
      (await f.call(B.token, 'GET', `/files/${fileId}/download-url`))
        .statusCode,
    ).toBe(404);
  });

  it('số tiền khai: bỏ trống = còn nợ (sau thu một phần), có giá trị thì giữ nguyên; ghi chú trống bỏ qua', async () => {
    const a = await setup(c1, P1);
    const pay = await f.call(
      A.token,
      'POST',
      `/invoices/${a.invoiceId}/payments`,
      {
        amount: 200_000,
        method: 'cash',
      },
    );
    expect(pay.statusCode, pay.body).toBe(201);
    const r1 = await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId });
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json()).toMatchObject({ amount: TOTAL - 200_000, note: null });

    const b = await setup(c1, P1);
    const r2 = await claim(P1, b.invoiceId, {
      receiptFileId: b.receiptFileId,
      amount: 500_000,
      note: '   ',
    });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json()).toMatchObject({ amount: 500_000, note: null });
    for (const bad of [
      { amount: 0 },
      { amount: -5 },
      { amount: 1.5 },
      { note: 'x'.repeat(301) },
    ]) {
      const x = await setup(c1, P1);
      const r = await claim(P1, x.invoiceId, {
        receiptFileId: x.receiptFileId,
        ...bad,
      });
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
      expect((await inv(x.invoiceId)).status).toBe('issued');
    }
  });

  it('không báo được: con người khác, tenant khác, nháp, không tồn tại → 404; hủy/đã thu đủ → 409 INVOICE_NOT_PAYABLE; không có khóa → 422', async () => {
    const mine = await setup(c1, P1);
    const other = await setup(c2, P2);
    const foreign = await setup(c3, P3);
    const draft = await f.invoice(c1, { status: 'draft' });
    const draftFile = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: draft,
    });
    const voided = await f.invoice(c1, { status: 'void' });
    const voidedFile = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: voided,
    });
    const paid = await setup(c1, P1);
    expect(
      (
        await f.call(A.token, 'POST', `/invoices/${paid.invoiceId}/payments`, {
          amount: TOTAL,
          method: 'cash',
        })
      ).statusCode,
    ).toBe(201);

    for (const [name, p, id, file] of [
      ['hóa đơn con phụ huynh khác', P1, other.invoiceId, mine.receiptFileId],
      ['hóa đơn tenant khác', P1, foreign.invoiceId, mine.receiptFileId],
      ['nháp', P1, draft, draftFile],
      ['không tồn tại', P1, randomUUID(), mine.receiptFileId],
    ] as const) {
      const r = await claim(p, id, { receiptFileId: file });
      expect(r.statusCode, name).toBe(404);
      expect(r.json().code, name).toBe('NOT_FOUND');
    }
    for (const [name, id, file] of [
      ['đã hủy', voided, voidedFile],
      ['đã thu đủ', paid.invoiceId, paid.receiptFileId],
    ] as const) {
      const r = await claim(P1, id, { receiptFileId: file });
      expect(r.statusCode, name).toBe(409);
      expect(r.json().code, name).toBe('INVOICE_NOT_PAYABLE');
    }
    expect(
      (
        await claim(
          P1,
          mine.invoiceId,
          { receiptFileId: mine.receiptFileId },
          null,
        )
      ).statusCode,
    ).toBe(422);
    expect((await inv(mine.invoiceId)).status).toBe('issued');
    expect(
      await q(`select 1 from payment_claims where invoice_id = $1`, [
        mine.invoiceId,
      ]),
    ).toHaveLength(0);
  });

  it('tệp biên lai phải ready, của chính mình, đúng hóa đơn, chưa dùng; thiếu → 422 ở receiptFileId, hóa đơn không đổi', async () => {
    const a = await setup(c1, P1);
    const other = await setup(c2, P2);
    const otherInvoiceFile = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: other.invoiceId,
    });
    const pending = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: a.invoiceId,
      status: 'pending',
    });
    const theirs = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P2.userId,
      entityId: a.invoiceId,
    });
    for (const [name, file] of [
      ['pending', pending],
      ['của phụ huynh khác', theirs],
      ['của hóa đơn khác', otherInvoiceFile],
      ['không tồn tại', randomUUID()],
    ] as const) {
      const r = await claim(P1, a.invoiceId, { receiptFileId: file });
      expect(r.statusCode, name).toBe(422);
      expect(
        r.json().errors?.receiptFileId ?? r.json().details,
        name,
      ).toBeDefined();
      expect((await inv(a.invoiceId)).status, name).toBe('issued');
    }
    expect((await claim(P1, a.invoiceId, {})).statusCode).toBe(422);
    // Dùng một biên lai cho hai lần báo bị chặn: báo, từ chối, rồi dùng lại tệp cũ.
    const ok = await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(
      (
        await resolve(A, ok.json().id, {
          decision: 'reject',
          reason: 'Chưa thấy tiền về',
        })
      ).statusCode,
    ).toBe(200);
    const reuse = await claim(P1, a.invoiceId, {
      receiptFileId: a.receiptFileId,
    });
    expect(reuse.statusCode).toBe(422);
  });

  it('một lần báo pending mỗi hóa đơn: báo thêm → 409 CONFLICT_STALE; hai request song song chỉ một thắng; cùng Idempotency-Key trả lại đúng kết quả cũ', async () => {
    const a = await setup(c1, P1);
    const second = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: a.invoiceId,
    });
    const key = randomUUID();
    const first = await claim(
      P1,
      a.invoiceId,
      { receiptFileId: a.receiptFileId },
      key,
    );
    expect(first.statusCode, first.body).toBe(201);
    const replay = await claim(
      P1,
      a.invoiceId,
      { receiptFileId: a.receiptFileId },
      key,
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const dup = await claim(P1, a.invoiceId, { receiptFileId: second });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('CONFLICT_STALE');
    expect(
      await q(`select 1 from payment_claims where invoice_id = $1`, [
        a.invoiceId,
      ]),
    ).toHaveLength(1);
    expect(await outbox('payment_claim_created', a.invoiceId)).toHaveLength(1);

    const b = await setup(c1, P1);
    const b2 = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: b.invoiceId,
    });
    const both = await Promise.all([
      claim(P1, b.invoiceId, { receiptFileId: b.receiptFileId }),
      claim(P1, b.invoiceId, { receiptFileId: b2 }),
    ]);
    expect(both.map((r) => r.statusCode).sort((x, y) => x - y)).toEqual([
      201, 409,
    ]);
    expect(
      await q(`select 1 from payment_claims where invoice_id = $1`, [
        b.invoiceId,
      ]),
    ).toHaveLength(1);
    expect((await inv(b.invoiceId)).status).toBe('pending_confirmation');
  });

  it('chưa đồng ý điều khoản → 403 CONSENT_REQUIRED; giáo viên gọi route phụ huynh → 403; phụ huynh gọi route giáo viên → 403', async () => {
    const np = await f.mkParent(false);
    const nc = await f.child(A, np, 'Chưa đồng ý', false);
    const a = await setup(nc, np);
    const r = await claim(np, a.invoiceId, { receiptFileId: a.receiptFileId });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CONSENT_REQUIRED');
    expect((await inv(a.invoiceId)).status).toBe('issued');

    const mine = await setup(c1, P1);
    expect(
      (
        await f.call(
          A.token,
          'POST',
          `/family/invoices/${mine.invoiceId}/payment-claims`,
          { receiptFileId: mine.receiptFileId },
        )
      ).statusCode,
    ).toBe(403);
    const ok = (
      await claim(P1, mine.invoiceId, { receiptFileId: mine.receiptFileId })
    ).json() as Claim;
    expect(
      (
        await f.call(
          P1.token,
          'GET',
          `/invoices/${mine.invoiceId}/payment-claims`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await resolve(P1, ok.id, { decision: 'reject', reason: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await claim({ ...P1, token: 'rác' }, mine.invoiceId, {
          receiptFileId: mine.receiptFileId,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('AC2 confirm: đúng MỘT thanh toán bank_transfer qua đường payments, hóa đơn paid, sổ doanh thu một dòng, đối soát billing.reconcile 0 lệch, idempotent', async () => {
    const a = await setup(c1, P1);
    await seedDunning(c1, a.invoiceId);
    const c = (
      await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId })
    ).json() as Claim;
    const key = randomUUID();
    const res = await resolve(A, c.id, { decision: 'confirm' }, key);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Resolved;
    expect(body.claim).toMatchObject({
      id: c.id,
      status: 'confirmed',
      amount: TOTAL,
      resolvedBy: { id: A.userId, name: 'Cô Lan' },
      rejectReason: null,
    });
    expect(body.claim.resolvedAt).toMatch(/\+07:00$/);
    expect(body.result).toMatchObject({
      payment: { method: 'bank_transfer', amount: TOTAL },
      status: 'paid',
      paidAmount: TOTAL,
      remainingAmount: 0,
    });
    expect(body.claim.paymentId).toBe(body.result!.payment.id);
    const pays = await payments(a.invoiceId);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ method: 'bank_transfer', voided_at: null });
    expect(Number(pays[0].amount)).toBe(TOTAL);
    expect(
      await q(`select amount from revenue_ledger where payment_id = $1`, [
        body.claim.paymentId,
      ]),
    ).toHaveLength(1);
    expect(await inv(a.invoiceId)).toMatchObject({ status: 'paid' });
    expect(
      (await dunning(a.invoiceId)).every((d) => d.status === 'cancelled'),
    ).toBe(true);
    expect(await outbox('payment_recorded', a.invoiceId)).toHaveLength(1);
    const sum = await sums(A.tenantId);
    expect(sum.invoices).toBe(sum.payments);
    expect(sum.revenue).toBe(sum.payments);
    expect(await reconcileMismatches()).toBe(0);

    const replay = await resolve(A, c.id, { decision: 'confirm' }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(body);
    expect(await payments(a.invoiceId)).toHaveLength(1);
    const again = await resolve(A, c.id, { decision: 'confirm' });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('CONFLICT_STALE');
    expect(
      (await resolve(A, c.id, { decision: 'reject', reason: 'nhầm' }))
        .statusCode,
    ).toBe(409);
    expect(await payments(a.invoiceId)).toHaveLength(1);
    const after = await claim(P1, a.invoiceId, {
      receiptFileId: a.receiptFileId,
    });
    expect(after.statusCode).toBe(409);
    expect(after.json().code).toBe('INVOICE_NOT_PAYABLE');
    expect(await reconcileMismatches()).toBe(0);
  });

  it('confirm: giáo viên quyết số ghi thu và ngày thu; thu một phần → partially_paid, nhắc nợ lập lại, phụ huynh báo tiếp phần còn lại', async () => {
    const a = await setup(c1, P1);
    await seedDunning(c1, a.invoiceId);
    const c = (
      await claim(P1, a.invoiceId, {
        receiptFileId: a.receiptFileId,
        amount: TOTAL,
      })
    ).json() as Claim;
    expect(
      (await dunning(a.invoiceId)).every(
        (d) => d.cancel_reason === 'claim_pending',
      ),
    ).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const res = await resolve(A, c.id, {
      decision: 'confirm',
      amount: 300_000,
      paidOn: today,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Resolved;
    expect(body.claim.amount).toBe(TOTAL); // số khai giữ nguyên
    expect(body.result).toMatchObject({
      payment: { amount: 300_000, method: 'bank_transfer' },
      status: 'partially_paid',
      remainingAmount: TOTAL - 300_000,
    });
    expect(
      (await dunning(a.invoiceId)).every((d) => d.status === 'pending'),
    ).toBe(true);
    expect(await reconcileMismatches()).toBe(0);

    const next = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: a.invoiceId,
    });
    const c2n = await claim(P1, a.invoiceId, { receiptFileId: next });
    expect(c2n.statusCode, c2n.body).toBe(201);
    expect(c2n.json().amount).toBe(TOTAL - 300_000);
    const bad = await resolve(A, c2n.json().id, {
      decision: 'confirm',
      paidOn: '2999-01-01',
    });
    expect(bad.statusCode).toBe(422);
    expect((await inv(a.invoiceId)).status).toBe('pending_confirmation');
    expect((await claim(P1, randomUUID(), {})).statusCode).toBe(422);
  });

  it('AC3 reject: lý do bắt buộc, hóa đơn về issued, nhắc nợ lập lại, không có thanh toán, outbox cho phụ huynh, xử lý lần hai 409; báo lại bằng biên lai mới', async () => {
    const a = await setup(c1, P1);
    await seedDunning(c1, a.invoiceId);
    const c = (
      await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId })
    ).json() as Claim;
    for (const bad of [
      { decision: 'reject' },
      { decision: 'reject', reason: '   ' },
      { decision: 'reject', reason: 'x'.repeat(301) },
      { decision: 'nope' },
    ]) {
      expect(
        (await resolve(A, c.id, bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    }
    expect((await inv(a.invoiceId)).status).toBe('pending_confirmation');

    const key = randomUUID();
    const res = await resolve(
      A,
      c.id,
      { decision: 'reject', reason: 'Chưa thấy tiền về tài khoản' },
      key,
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Resolved;
    expect(body.result).toBeNull();
    expect(body.claim).toMatchObject({
      status: 'rejected',
      rejectReason: 'Chưa thấy tiền về tài khoản',
      resolvedBy: { id: A.userId, name: 'Cô Lan' },
      paymentId: null,
    });
    expect((await inv(a.invoiceId)).status).toBe('issued');
    expect(await payments(a.invoiceId)).toHaveLength(0);
    expect(
      (await dunning(a.invoiceId)).every(
        (d) => d.status === 'pending' && d.cancel_reason === null,
      ),
    ).toBe(true);
    const ev = await outbox('payment_claim_rejected', a.invoiceId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({ claimId: c.id, invoiceId: a.invoiceId });
    expect(
      (
        await resolve(
          A,
          c.id,
          { decision: 'reject', reason: 'Chưa thấy tiền về tài khoản' },
          key,
        )
      ).json(),
    ).toEqual(body);
    // Cùng khóa khác nội dung bị từ chối.
    expect(
      (await resolve(A, c.id, { decision: 'confirm' }, key)).statusCode,
    ).toBe(422);
    expect((await resolve(A, c.id, { decision: 'confirm' })).statusCode).toBe(
      409,
    );
    expect(await reconcileMismatches()).toBe(0);

    const fresh = await f.dbFile({
      tenantId: A.tenantId,
      ownerUserId: P1.userId,
      entityId: a.invoiceId,
    });
    const again = await claim(P1, a.invoiceId, { receiptFileId: fresh });
    expect(again.statusCode, again.body).toBe(201);
    const list = (
      await f.call(A.token, 'GET', `/invoices/${a.invoiceId}/payment-claims`)
    ).json() as { items: Claim[] };
    expect(list.items.map((i) => i.status)).toEqual(['pending', 'rejected']);
  });

  it('giáo viên ghi thu trực tiếp trong lúc chờ: reject giữ trạng thái partially_paid; confirm khi đã thu đủ → 409 INVOICE_NOT_PAYABLE, lần báo vẫn pending', async () => {
    const a = await setup(c1, P1);
    const ca = (
      await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId })
    ).json() as Claim;
    expect(
      (
        await f.call(A.token, 'POST', `/invoices/${a.invoiceId}/payments`, {
          amount: 400_000,
          method: 'cash',
        })
      ).statusCode,
    ).toBe(201);
    expect((await inv(a.invoiceId)).status).toBe('partially_paid');
    const rej = await resolve(A, ca.id, {
      decision: 'reject',
      reason: 'Đã nhận tiền mặt',
    });
    expect(rej.statusCode, rej.body).toBe(200);
    expect((await inv(a.invoiceId)).status).toBe('partially_paid');

    const b = await setup(c1, P1);
    const cb = (
      await claim(P1, b.invoiceId, { receiptFileId: b.receiptFileId })
    ).json() as Claim;
    expect(
      (
        await f.call(A.token, 'POST', `/invoices/${b.invoiceId}/payments`, {
          amount: TOTAL,
          method: 'cash',
        })
      ).statusCode,
    ).toBe(201);
    const conf = await resolve(A, cb.id, { decision: 'confirm' });
    expect(conf.statusCode).toBe(409);
    expect(conf.json().code).toBe('INVOICE_NOT_PAYABLE');
    expect(
      (await q(`select status from payment_claims where id = $1`, [cb.id]))[0]
        .status,
    ).toBe('pending');
    expect(await payments(b.invoiceId)).toHaveLength(1);
    expect(await reconcileMismatches()).toBe(0);
  });

  it('kỳ sau phát hành khi hóa đơn còn chờ xác nhận: không kết chuyển; xác nhận thu được ở hóa đơn cũ; bị từ chối thì lần phát hành kế tiếp mới kết chuyển', async () => {
    const D = await f.mkTeacher('Cô Dung');
    const P4 = await f.mkParent(true, 'Phụ huynh Bốn');
    const c4 = await f.child(D, P4, 'Đỗ An');
    const c5 = await f.child(D, P4, 'Đỗ Bình');
    await q(
      `insert into payout_accounts (id, tenant_id, bank_bin, account_no, account_name, is_primary) values ($1, $2, '970436', '0011001234567', 'GV', true)`,
      [randomUUID(), D.tenantId],
    );
    /** Nháp kỳ `month` của `c` có một dòng phát sinh 500.000 rồi phát hành qua API; trả hóa đơn sau phát hành. */
    const issueNext = async (c: Child, month: string) => {
      const [periodId, invoiceId] = [randomUUID(), randomUUID()];
      await q(
        `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $3, ($3::date + 9))`,
        [periodId, D.tenantId, month],
      );
      await q(
        `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, 500000)`,
        [invoiceId, D.tenantId, periodId, c.studentId],
      );
      await q(
        `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount) values ($1, $2, $3, 1, 'monthly', 'Học phí tháng', 500000)`,
        [randomUUID(), D.tenantId, invoiceId],
      );
      const r = await f.call(
        D.token,
        'POST',
        `/billing-periods/${periodId}/issue`,
        { invoiceIds: [invoiceId] },
      );
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().issuedCount).toBe(1);
      const lines = await q(
        `select kind, amount::int from invoice_lines where invoice_id = $1 order by position`,
        [invoiceId],
      );
      return { ...(await inv(invoiceId)), lines };
    };

    // Xác nhận: kỳ 2 phát hành trước khi duyệt không lấy nợ kỳ 1; duyệt thu đủ ở kỳ 1.
    const a = await setup(c4, P4);
    const ca = (
      await claim(P4, a.invoiceId, { receiptFileId: a.receiptFileId })
    ).json() as Claim;
    const n1 = await issueNext(c4, '2099-01-01');
    expect(n1.lines.map((l: { kind: string }) => l.kind)).toEqual(['monthly']);
    expect(Number(n1.total_amount)).toBe(500_000);
    expect(Number((await inv(a.invoiceId)).carried_amount)).toBe(0);
    const ok = await resolve(D, ca.id, { decision: 'confirm' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as Resolved).result).toMatchObject({
      status: 'paid',
      paidAmount: TOTAL,
      remainingAmount: 0,
    });

    // Từ chối: hóa đơn về issued, kỳ phát hành kế tiếp kết chuyển đủ nợ (cùng nợ của kỳ 2 chưa thu).
    const b = await setup(c5, P4);
    const cb = (
      await claim(P4, b.invoiceId, { receiptFileId: b.receiptFileId })
    ).json() as Claim;
    const n2 = await issueNext(c5, '2099-02-01');
    expect(n2.lines.map((l: { kind: string }) => l.kind)).toEqual(['monthly']);
    expect(
      (
        await resolve(D, cb.id, {
          decision: 'reject',
          reason: 'Chưa thấy tiền về',
        })
      ).statusCode,
    ).toBe(200);
    expect((await inv(b.invoiceId)).status).toBe('issued');
    const n3 = await issueNext(c5, '2099-03-01');
    expect(n3.lines).toEqual([
      { kind: 'monthly', amount: 500_000 },
      { kind: 'carry_over', amount: TOTAL + 500_000 },
    ]);
    expect(Number(n3.total_amount)).toBe(1_000_000 + TOTAL);
    expect(Number((await inv(b.invoiceId)).carried_amount)).toBe(TOTAL);
    expect(await reconcileMismatches()).toBe(0);
  });

  it('chéo tenant / vai trò: giáo viên tenant khác 404 ở list và resolve; id lạ 404; claim không đổi', async () => {
    const a = await setup(c1, P1);
    const c = (
      await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId })
    ).json() as Claim;
    const l = await f.call(
      B.token,
      'GET',
      `/invoices/${a.invoiceId}/payment-claims`,
    );
    expect(l.statusCode).toBe(404);
    expect(l.json().code).toBe('NOT_FOUND');
    for (const body of [
      { decision: 'confirm' },
      { decision: 'reject', reason: 'x' },
    ]) {
      const r = await resolve(B, c.id, body);
      expect(r.statusCode).toBe(404);
      expect(r.json().code).toBe('NOT_FOUND');
    }
    expect(
      (await resolve(A, randomUUID(), { decision: 'confirm' })).statusCode,
    ).toBe(404);
    expect(
      (await f.call(A.token, 'GET', `/invoices/${randomUUID()}/payment-claims`))
        .statusCode,
    ).toBe(404);
    const draft = await f.invoice(c1, { status: 'draft' });
    expect(
      (await f.call(A.token, 'GET', `/invoices/${draft}/payment-claims`))
        .statusCode,
    ).toBe(404);
    expect(
      (await q(`select status from payment_claims where id = $1`, [c.id]))[0]
        .status,
    ).toBe('pending');
    expect(await payments(a.invoiceId)).toHaveLength(0);
    expect(
      (await f.call(null, 'GET', `/invoices/${a.invoiceId}/payment-claims`))
        .statusCode,
    ).toBe(401);
  });

  it('RLS trực tiếp: phụ huynh khác/tenant khác 0 dòng; phụ huynh không sửa hóa đơn hay lần báo; hàm tạo không dùng chéo người, chéo tệp; claim đã xử lý bất biến', async () => {
    const a = await setup(c1, P1);
    const c = (
      await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId })
    ).json() as Claim;
    const count = async (userId: string) =>
      (
        await asUser<{ n: number }>(
          userId,
          `select count(*)::int n from payment_claims where id = $1`,
          [c.id],
        )
      ).rows[0]!.n;
    expect(await count(P1.userId)).toBe(1);
    expect(await count(A.userId)).toBe(1);
    for (const who of [P2.userId, P3.userId, B.userId])
      expect(await count(who)).toBe(0);

    expect(
      (
        await asUser(
          P1.userId,
          `update invoices set status = 'issued' where id = $1`,
          [a.invoiceId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await asUser(
          P1.userId,
          `update payment_claims set status = 'confirmed' where id = $1`,
          [c.id],
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      asUser(
        P1.userId,
        `insert into payment_claims (id, tenant_id, invoice_id, receipt_file_id, amount, claimed_by, claimed_by_name)
         values (gen_random_uuid(), $1, $2, $3, 1, $4, 'x')`,
        [A.tenantId, a.invoiceId, a.receiptFileId, P1.userId],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(A.userId, `delete from payment_claims where id = $1`, [c.id]),
    ).rejects.toThrow(/permission denied/);

    const fn = (userId: string, invoiceId: string, file: string) =>
      asUser<{ r: { result: string } }>(
        userId,
        `select app_private.create_payment_claim($1::uuid, $2::uuid, null, null) as r`,
        [invoiceId, file],
      );
    const other = await setup(c2, P2);
    expect(
      (await fn(P1.userId, other.invoiceId, other.receiptFileId)).rows[0]!.r
        .result,
    ).toBe('not_found');
    expect(
      (await fn(A.userId, a.invoiceId, a.receiptFileId)).rows[0]!.r.result,
    ).toBe('not_found');
    const mine = await setup(c1, P1);
    expect(
      (await fn(P1.userId, mine.invoiceId, other.receiptFileId)).rows[0]!.r
        .result,
    ).toBe('bad_file');
    await expect(
      asUser(
        P1.userId,
        `select app_private.create_payment_claim($1::uuid, $2::uuid, null, null)`,
        [mine.invoiceId, mine.receiptFileId],
      ).then(() =>
        asUser(
          '',
          `select app_private.create_payment_claim($1::uuid, $2::uuid, null, null)`,
          [mine.invoiceId, mine.receiptFileId],
        ),
      ),
    ).rejects.toThrow(/cần người dùng đăng nhập/);

    // Đã xử lý thì bất biến, kể cả với role worker (BYPASSRLS).
    expect(
      (await resolve(A, c.id, { decision: 'reject', reason: 'x' })).statusCode,
    ).toBe(200);
    await expect(
      q(`update payment_claims set reject_reason = 'sửa lại' where id = $1`, [
        c.id,
      ]),
    ).rejects.toThrow(/PAYMENT_CLAIM_IMMUTABLE/);
    await expect(
      q(`update payment_claims set amount = 5 where id = $1`, [c.id]),
    ).rejects.toThrow(/PAYMENT_CLAIM_IMMUTABLE/);
  });

  it('thông báo: payment_claim_created tới chủ tenant, payment_claim_rejected tới phụ huynh đã báo, không số tiền; idempotent; bỏ qua khi đã xử lý', async () => {
    const { PaymentClaimNotifier } =
      await import('../libs/modules/notifications/application/payment-claim-notifier.service.js');
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const deliver = vi.fn().mockResolvedValue(true);
    const notifier = new PaymentClaimNotifier(
      new TxService(drizzle(t.worker, { schema, casing: 'snake_case' })),
      { deliver } as never,
    );
    const a = await setup(c1, P1, { total: 777_000 });
    const c = (
      await claim(P1, a.invoiceId, { receiptFileId: a.receiptFileId })
    ).json() as Claim;
    const created = (await outbox('payment_claim_created', a.invoiceId))[0];
    const job = (payload: object) => ({
      eventId: randomUUID(),
      tenantId: A.tenantId,
      payload,
    });
    const jc = job(created.payload);
    await notifier.handleCreated(jc);
    await notifier.handleCreated(jc);
    const rows = await q(
      `select recipient_user_id, type, payload from notifications where type = 'payment_claim_created' and payload->>'claimId' = $1`,
      [c.id],
    );
    expect(rows).toEqual([
      {
        recipient_user_id: A.userId,
        type: 'payment_claim_created',
        payload: { claimId: c.id, invoiceId: a.invoiceId },
      },
    ]);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: A.userId,
        type: 'payment_claim_created',
      }),
    );
    expect(JSON.stringify(rows)).not.toContain('777000');

    // Chưa bị từ chối thì không gửi `rejected`.
    await notifier.handleRejected(
      job({ claimId: c.id, invoiceId: a.invoiceId }),
    );
    expect(
      await q(
        `select 1 from notifications where type = 'payment_claim_rejected' and payload->>'claimId' = $1`,
        [c.id],
      ),
    ).toHaveLength(0);
    expect(
      (await resolve(A, c.id, { decision: 'reject', reason: 'Chưa nhận được' }))
        .statusCode,
    ).toBe(200);
    const rej = job(
      (await outbox('payment_claim_rejected', a.invoiceId))[0].payload,
    );
    await notifier.handleRejected(rej);
    await notifier.handleRejected(rej);
    const rr = await q(
      `select recipient_user_id, payload from notifications where type = 'payment_claim_rejected' and payload->>'claimId' = $1`,
      [c.id],
    );
    expect(rr).toEqual([
      {
        recipient_user_id: P1.userId,
        payload: {
          claimId: c.id,
          invoiceId: a.invoiceId,
          reason: 'Chưa nhận được',
        },
      },
    ]);
    // Đã xử lý trước khi worker chạy: không còn "cần xác nhận".
    await notifier.handleCreated(
      job({ claimId: c.id, invoiceId: a.invoiceId }),
    );
    expect(
      await q(
        `select 1 from notifications where type = 'payment_claim_created' and payload->>'claimId' = $1`,
        [c.id],
      ),
    ).toHaveLength(1);
    // Phụ huynh nhận thông báo trong hộp thư của mình qua API.
    const inbox = await f.call(P1.token, 'GET', '/notifications');
    expect(inbox.statusCode, inbox.body).toBe(200);
  });

  it('tệp bị ghi đè sau complete (ETag đổi) → 422 ở receiptFileId, hóa đơn không đổi; tệp biến mất cũng 422', async () => {
    const a = await f.invoice(c1);
    const fileId = await f.uploadReceipt(P1, a);
    const [row] = await q(
      `select bucket, object_key from files where id = $1`,
      [fileId],
    );
    const s3c = new S3Client({
      endpoint: s3.env.S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: s3.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: s3.env.S3_SECRET_ACCESS_KEY!,
      },
    });
    await s3c.send(
      new PutObjectCommand({
        Bucket: row.bucket,
        Key: row.object_key,
        Body: Buffer.from('thay-the-sau-complete'),
        ContentType: 'image/jpeg',
      }),
    );
    const r = await claim(P1, a, { receiptFileId: fileId });
    expect(r.statusCode, r.body).toBe(422);
    expect(JSON.stringify(r.json())).toContain('receiptFileId');
    expect((await inv(a)).status).toBe('issued');
    expect(
      await q(`select 1 from payment_claims where invoice_id = $1`, [a]),
    ).toHaveLength(0);
    s3c.destroy();
  });

  it('audit payment_claims không chứa ghi chú, lý do từ chối, tên người báo/xử lý', async () => {
    const a = await setup(c1, P1);
    const c = (
      await claim(P1, a.invoiceId, {
        receiptFileId: a.receiptFileId,
        note: 'GHI-CHU-RIENG',
      })
    ).json() as Claim;
    expect(
      (await resolve(A, c.id, { decision: 'reject', reason: 'LY-DO-RIENG' }))
        .statusCode,
    ).toBe(200);
    const rows = await q(
      `select before_data, after_data from audit_logs where entity = 'payment_claims' and entity_id = $1`,
      [c.id],
    );
    expect(rows).toHaveLength(2);
    const all = JSON.stringify(rows);
    for (const secret of [
      'GHI-CHU-RIENG',
      'LY-DO-RIENG',
      'Nguyễn Văn Hải',
      'Cô Lan',
    ])
      expect(all).not.toContain(secret);
    expect(all).toContain('rejected');
  });
});
