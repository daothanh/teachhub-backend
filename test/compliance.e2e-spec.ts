import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type {
  ComplianceChecklist,
  LegalArticleViewPage,
  RevenueBook,
} from '../libs/modules/compliance/http/compliance.schemas.js';
import { generateInvoiceCode } from '../libs/modules/billing/domain/invoice-issue.js';
import { localDate } from '../libs/modules/schedule/domain/zoned-time.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

const YEAR = Number(localDate(new Date(), 'Asia/Ho_Chi_Minh').slice(0, 4));

// S8 compliance (US-9.1, 9.3, 9.5, 9.6): checklist, sổ doanh thu + cảnh báo 80%, thư viện quy định, xác nhận cảnh báo lớp.
describe('compliance: checklist, sổ doanh thu, thư viện quy định, xác nhận cảnh báo', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;
  let C: Who;
  let teacher: { token: string };
  let parent: { token: string };

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    who: { token: string },
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}),
      },
    });
  const get = async <T>(who: { token: string }, url: string): Promise<T> => {
    const r = await call(who, 'GET', url);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as T;
  };

  /** Hóa đơn đã phát hành, tổng lớn, phát hành từ đầu năm trước để nhận thu cả hai năm. */
  const bigInvoice = async (who: Who, total: number) => {
    const stu = randomUUID();
    await q(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'HS')`,
      [stu, who.tenantId],
    );
    const period = randomUUID();
    const id = randomUUID();
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
       values ($1, $2, '2020-01-01', '2020-01-01', '2020-01-10')`,
      [period, who.tenantId],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [id, who.tenantId, period, stu, total],
    );
    const code = generateInvoiceCode();
    await q(
      `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = '000201',
         payout = '{"bankBin":"970436","accountNo":"0011001234567","accountName":"NGUYEN VAN A"}'::jsonb,
         issued_at = $4 where id = $1`,
      [id, code, code.replace('-', ' '), `${YEAR - 1}-01-01T00:00:00Z`],
    );
    return id;
  };
  const pay = async (
    who: Who,
    invoiceId: string,
    amount: number,
    paidOn?: string,
  ) => {
    const r = await call(who, 'POST', `/invoices/${invoiceId}/payments`, {
      amount,
      method: 'bank_transfer',
      ...(paidOn ? { paidOn } : {}),
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { payment: { id: string } }).payment.id;
  };
  const book = (who: Who, query = '') =>
    get<RevenueBook>(who, `/compliance/revenue-book${query}`);
  const outbox = async (who: Who) =>
    q(
      `select payload from outbox_events where tenant_id = $1 and type = 'tax_threshold_alert' order by created_at`,
      [who.tenantId],
    );

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B, C] = [await mk(), await mk(), await mk()];
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
  }, 180_000);

  afterAll(async () => {
    await t?.stop();
  });

  describe('checklist (US-9.1)', () => {
    it('tenant mới: bốn mục todo, 0%, bước tiếp theo là mục đầu', async () => {
      const c = await get<ComplianceChecklist>(A, '/compliance/checklist');
      expect(c.items.map((i) => [i.itemKey, i.status, i.auto])).toEqual([
        ['business_registration', 'todo', false],
        ['registration_number', 'todo', false],
        ['public_disclosure', 'todo', true],
        ['school_declaration', 'todo', true],
      ]);
      expect(c).toMatchObject({
        totalCount: 4,
        completedCount: 0,
        percent: 0,
        nextItemKey: 'business_registration',
      });
    });

    it('đánh dấu mục: số GCN bắt buộc, mục tự suy ra bị từ chối, % và bước tiếp theo cập nhật, gọi lại không đổi thời điểm', async () => {
      let r = await call(
        A,
        'PATCH',
        '/compliance/checklist/registration_number',
        { status: 'done' },
      );
      expect(r.statusCode).toBe(422);
      expect(r.json().errors).toHaveProperty(['data.registrationNo']);
      r = await call(
        A,
        'PATCH',
        '/compliance/checklist/business_registration',
        { status: 'done', data: { registrationNo: '01' } },
      );
      expect(r.statusCode).toBe(422);
      r = await call(A, 'PATCH', '/compliance/checklist/public_disclosure', {
        status: 'done',
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().errors).toHaveProperty('itemKey');

      r = await call(
        A,
        'PATCH',
        '/compliance/checklist/business_registration',
        { status: 'done' },
      );
      expect(r.statusCode, r.body).toBe(200);
      const first = r.json() as ComplianceChecklist;
      expect(first).toMatchObject({
        completedCount: 1,
        percent: 25,
        nextItemKey: 'registration_number',
      });
      const at = first.items[0]!.completedAt;
      expect(at).not.toBeNull();
      await new Promise((res) => setTimeout(res, 20));
      r = await call(
        A,
        'PATCH',
        '/compliance/checklist/business_registration',
        { status: 'done' },
      );
      expect((r.json() as ComplianceChecklist).items[0]!.completedAt).toBe(at);

      r = await call(A, 'PATCH', '/compliance/checklist/registration_number', {
        status: 'done',
        data: { registrationNo: '01A8012345' },
      });
      const c = r.json() as ComplianceChecklist;
      expect(c.items[1]).toMatchObject({
        status: 'done',
        data: { registrationNo: '01A8012345' },
      });
      expect(c).toMatchObject({
        completedCount: 2,
        percent: 50,
        nextItemKey: 'public_disclosure',
      });

      r = await call(
        A,
        'PATCH',
        '/compliance/checklist/business_registration',
        { status: 'todo' },
      );
      expect(r.json() as ComplianceChecklist).toMatchObject({
        completedCount: 1,
        nextItemKey: 'business_registration',
      });
    });

    it('chéo tenant: checklist của A không lộ sang B và PATCH của B không đổi A', async () => {
      const b = await get<ComplianceChecklist>(B, '/compliance/checklist');
      expect(b.completedCount).toBe(0);
      expect(b.items[1]!.data).toBeNull();
      await call(B, 'PATCH', '/compliance/checklist/registration_number', {
        status: 'done',
        data: { registrationNo: 'B-1' },
      });
      const a = await get<ComplianceChecklist>(A, '/compliance/checklist');
      expect(a.items[1]!.data).toEqual({ registrationNo: '01A8012345' });
      expect(
        await q(
          `select count(*)::int as n from compliance_items where tenant_id = $1`,
          [A.tenantId],
        ),
      ).toEqual([{ n: 2 }]);
    });

    it('phụ huynh và giáo viên thường → 403', async () => {
      for (const who of [parent, teacher]) {
        expect(
          (await call(who, 'GET', '/compliance/checklist')).statusCode,
        ).toBe(403);
        expect(
          (
            await call(
              who,
              'PATCH',
              '/compliance/checklist/business_registration',
              { status: 'done' },
            )
          ).statusCode,
        ).toBe(403);
        expect(
          (await call(who, 'GET', '/compliance/revenue-book')).statusCode,
        ).toBe(403);
        expect(
          (
            await call(
              who,
              'POST',
              `/compliance/tax-alerts/${randomUUID()}/dismiss`,
            )
          ).statusCode,
        ).toBe(403);
      }
    });
  });

  describe('sổ doanh thu và cảnh báo ngưỡng (US-9.5)', () => {
    let inv: string;
    let p400: string;

    it('chưa có thanh toán: lũy kế 0, 12 tháng, hai ngưỡng below, không cảnh báo', async () => {
      const b = await book(A);
      expect(b).toMatchObject({ year: YEAR, cumulativeAmount: 0, alerts: [] });
      expect(b.monthly).toHaveLength(12);
      expect(b.monthly[0]!.month).toBe(`${YEAR}-01`);
      expect(
        b.thresholds.map((x) => [
          x.thresholdAmount,
          x.warnAmount,
          x.status,
          x.progressPercent,
        ]),
      ).toEqual([
        [500_000_000, 400_000_000, 'below', 0],
        [1_000_000_000, 800_000_000, 'below', 0],
      ]);
      expect(b.entries).toMatchObject({ items: [], total: 0, totalAmount: 0 });
    });

    it('biên 80%: 399.999.999 chưa cảnh báo; đủ 400.000.000 thì sinh đúng một cảnh báo 400m + một sự kiện outbox không số tiền', async () => {
      inv = await bigInvoice(A, 3_000_000_000);
      await pay(A, inv, 399_999_999);
      let b = await book(A);
      expect(b.alerts).toEqual([]);
      expect(b.thresholds[0]!.status).toBe('below');
      expect(await outbox(A)).toEqual([]);

      p400 = await pay(A, inv, 1);
      b = await book(A);
      expect(b.cumulativeAmount).toBe(400_000_000);
      expect(b.thresholds.map((x) => [x.status, x.progressPercent])).toEqual([
        ['warning', 80],
        ['below', 40],
      ]);
      expect(b.alerts).toHaveLength(1);
      expect(b.alerts[0]).toMatchObject({
        milestone: '400m',
        warnAmount: 400_000_000,
        thresholdAmount: 500_000_000,
        cumulativeAmount: 400_000_000,
        paymentId: p400,
        dismissedAt: null,
        legalArticleSlug: null,
      });
      const ev = await outbox(A);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toEqual({
        alertId: b.alerts[0]!.id,
        fiscalYear: YEAR,
        milestone: '400m',
      });

      // Mở lại sổ: idempotent, không sinh thêm.
      await book(A);
      expect(await outbox(A)).toHaveLength(1);
      expect(
        (
          await q(
            `select count(*)::int as n from tax_threshold_alerts where tenant_id = $1`,
            [A.tenantId],
          )
        )[0],
      ).toEqual({ n: 1 });
    });

    it('hủy thanh toán làm doanh thu giảm rồi thu lại: cảnh báo giữ nguyên, không tạo trùng', async () => {
      const v = await call(A, 'POST', `/payments/${p400}/void`, {
        reason: 'nhập nhầm',
      });
      expect(v.statusCode, v.body).toBe(200);
      let b = await book(A);
      expect(b.cumulativeAmount).toBe(399_999_999);
      expect(b.thresholds[0]!.status).toBe('below');
      expect(b.alerts).toHaveLength(1);

      await pay(A, inv, 1);
      b = await book(A);
      expect(b.cumulativeAmount).toBe(400_000_000);
      expect(b.alerts).toHaveLength(1);
      expect(await outbox(A)).toHaveLength(1);
    });

    it('biên 100%: 500.000.000 là exceeded (tiến độ 100), 800.000.000 sinh cảnh báo 800m, mới trước', async () => {
      await pay(A, inv, 100_000_000);
      let b = await book(A);
      expect(b.thresholds[0]).toMatchObject({
        status: 'exceeded',
        progressPercent: 100,
      });
      expect(b.alerts.map((a) => a.milestone)).toEqual(['400m']);

      await pay(A, inv, 299_999_999);
      b = await book(A);
      expect(b.cumulativeAmount).toBe(799_999_999);
      expect(b.alerts.map((a) => a.milestone)).toEqual(['400m']);

      await pay(A, inv, 1);
      b = await book(A);
      expect(b.thresholds[1]).toMatchObject({
        status: 'warning',
        progressPercent: 80,
      });
      expect(b.alerts.map((a) => a.milestone)).toEqual(['800m', '400m']);
      expect(b.alerts[0]).toMatchObject({
        warnAmount: 800_000_000,
        thresholdAmount: 1_000_000_000,
        cumulativeAmount: 800_000_000,
      });
      expect(await outbox(A)).toHaveLength(2);
    });

    it('entries khớp sổ: tổng bằng lũy kế, gồm dòng đảo, phân trang', async () => {
      const b = await book(A, '?pageSize=2&page=1');
      expect(b.entries.total).toBe(
        (
          await q(
            `select count(*)::int as n from revenue_ledger where tenant_id = $1`,
            [A.tenantId],
          )
        )[0].n,
      );
      expect(b.entries.items).toHaveLength(2);
      expect(b.entries.totalAmount).toBe(b.cumulativeAmount);
      const all = await book(A, '?pageSize=100');
      expect(all.entries.items.reduce((n, e) => n + e.amount, 0)).toBe(
        all.cumulativeAmount,
      );
      expect(
        all.entries.items.some((e) => e.kind === 'reversal' && e.amount === -1),
      ).toBe(true);
      expect(all.monthly.reduce((n, m) => n + m.amount, 0)).toBe(
        all.cumulativeAmount,
      );
    });

    it('đóng cảnh báo: 204, gọi lại vẫn 204, không sinh lại; tenant khác và id lạ → 404', async () => {
      const [a800] = (await book(A)).alerts;
      let r = await call(
        A,
        'POST',
        `/compliance/tax-alerts/${a800!.id}/dismiss`,
      );
      expect(r.statusCode, r.body).toBe(204);
      r = await call(A, 'POST', `/compliance/tax-alerts/${a800!.id}/dismiss`);
      expect(r.statusCode).toBe(204);
      const b = await book(A);
      expect(b.alerts).toHaveLength(2);
      expect(
        b.alerts.find((x) => x.id === a800!.id)!.dismissedAt,
      ).not.toBeNull();
      expect(b.alerts.find((x) => x.id !== a800!.id)!.dismissedAt).toBeNull();

      const other = (await book(A)).alerts[1]!.id;
      expect(
        (await call(B, 'POST', `/compliance/tax-alerts/${other}/dismiss`))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await call(
            A,
            'POST',
            `/compliance/tax-alerts/${randomUUID()}/dismiss`,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (await book(A)).alerts.find((x) => x.id === other)!.dismissedAt,
      ).toBeNull();
    });

    it('chéo tenant: sổ doanh thu của A không lộ sang B', async () => {
      const b = await book(B);
      expect(b).toMatchObject({ cumulativeAmount: 0, alerts: [] });
      expect(b.entries.items).toEqual([]);
      expect(
        await q(
          `select count(*)::int as n from tax_threshold_alerts where tenant_id = $1`,
          [B.tenantId],
        ),
      ).toEqual([{ n: 0 }]);
    });

    it('năm theo fiscal_year: thu năm trước chỉ nằm ở sổ năm trước, không cộng vào năm nay; năm sai → 422', async () => {
      const inv2 = await bigInvoice(B, 10_000_000);
      await pay(B, inv2, 7_000_000, `${YEAR - 1}-12-31`);
      await pay(B, inv2, 3_000_000);
      const prev = await book(B, `?year=${YEAR - 1}`);
      expect(prev).toMatchObject({
        year: YEAR - 1,
        cumulativeAmount: 7_000_000,
      });
      expect(prev.monthly[11]).toEqual({
        month: `${YEAR - 1}-12`,
        amount: 7_000_000,
      });
      expect(prev.entries.items.map((e) => e.entryDate)).toEqual([
        `${YEAR - 1}-12-31`,
      ]);
      const cur = await book(B);
      expect(cur).toMatchObject({ year: YEAR, cumulativeAmount: 3_000_000 });
      expect(
        (await call(B, 'GET', '/compliance/revenue-book?year=1999')).statusCode,
      ).toBe(422);
      expect(
        (await call(B, 'GET', '/compliance/revenue-book?year=abc')).statusCode,
      ).toBe(422);
    });

    it('job compliance.tax-threshold: sinh cảnh báo cho tenant đã vượt mốc, chạy lại không sinh trùng, không đụng tenant chưa tới mốc', async () => {
      const inv3 = await bigInvoice(C, 900_000_000);
      const p = await pay(C, inv3, 400_000_000);
      const schema = await import('../libs/db/src/schema/index.js');
      const { TxService } = await import('../libs/db/src/tx.service.js');
      const { JobRuns } = await import('../libs/infra/src/job-runs.js');
      const { TaxThresholdJob } =
        await import('../libs/modules/compliance/application/tax-threshold.job.js');
      const { TaxThresholdService } =
        await import('../libs/modules/compliance/application/tax-threshold.service.js');
      const tx = new TxService(
        drizzle(t.worker, { schema, casing: 'snake_case' }),
      );
      const job = new TaxThresholdJob(
        tx,
        new JobRuns(tx),
        new TaxThresholdService(),
      );
      await job.run();
      await job.run();
      expect(await outbox(C)).toHaveLength(1);
      const [row] = await q(
        `select milestone, payment_id, cumulative_amount::text as cum from tax_threshold_alerts where tenant_id = $1`,
        [C.tenantId],
      );
      expect(row).toEqual({
        milestone: '400m',
        payment_id: p,
        cum: '400000000',
      });
      // Mở sổ sau job: vẫn một cảnh báo.
      expect((await book(C)).alerts).toHaveLength(1);
      expect(await outbox(C)).toHaveLength(1);
      expect(
        await q(`select 1 from tax_threshold_alerts where tenant_id = $1`, [
          B.tenantId,
        ]),
      ).toEqual([]);
    });

    it('TaxThresholdNotifier: một thông báo cho chủ tenant dù xử lý lại, payload không số tiền; cảnh báo đã đóng thì bỏ', async () => {
      const { TaxThresholdNotifier } =
        await import('../libs/modules/notifications/application/tax-threshold-notifier.service.js');
      const schema = await import('../libs/db/src/schema/index.js');
      const { TxService } = await import('../libs/db/src/tx.service.js');
      const deliver = vi.fn().mockResolvedValue(true);
      const notifier = new TaxThresholdNotifier(
        new TxService(drizzle(t.worker, { schema, casing: 'snake_case' })),
        { deliver } as never,
      );
      const [ev] = await q(
        `select id, payload from outbox_events where tenant_id = $1 and type = 'tax_threshold_alert'`,
        [C.tenantId],
      );
      const job = { eventId: ev.id, tenantId: C.tenantId, payload: ev.payload };
      await notifier.handle(job);
      await notifier.handle(job);
      const rows = await q(
        `select recipient_user_id, payload from notifications where tenant_id = $1 and type = 'tax_threshold_alert'`,
        [C.tenantId],
      );
      expect(rows).toEqual([
        {
          recipient_user_id: C.userId,
          payload: { fiscalYear: YEAR, milestone: '400m' },
        },
      ]);
      expect(deliver).toHaveBeenCalledTimes(2);

      await call(
        C,
        'POST',
        `/compliance/tax-alerts/${ev.payload.alertId}/dismiss`,
      );
      await notifier.handle({ ...job, eventId: randomUUID() });
      expect(
        await q(
          `select 1 from notifications where tenant_id = $1 and type = 'tax_threshold_alert'`,
          [C.tenantId],
        ),
      ).toHaveLength(1);
    });
  });

  describe('thư viện quy định (US-9.6)', () => {
    const art = (
      slug: string,
      title: string,
      status: 'draft' | 'published',
      summary = 'Tóm tắt.',
    ) =>
      q(
        `insert into legal_articles (id, slug, title, summary, body_markdown, sources, status, reviewed_by, reviewer_role, reviewed_on, published_at)
         values ($1, $2, $3, $4, '## Nội dung', '[{"title":"TT29","url":"https://example.com/tt29"}]'::jsonb, $5,
                 $6, $7, $8, $9)`,
        [
          randomUUID(),
          slug,
          title,
          summary,
          status,
          status === 'published' ? 'LS. Trần Thị Mai' : null,
          status === 'published' ? 'lawyer' : null,
          status === 'published' ? '2026-12-19' : null,
          status === 'published' ? new Date() : null,
        ],
      );

    it('chưa có bài nào: danh sách rỗng, bài lạ → 404', async () => {
      const l = await get<LegalArticleViewPage>(A, '/legal-articles');
      expect(l).toMatchObject({ items: [], total: 0 });
      expect(
        (await call(A, 'GET', '/legal-articles/dang-ky-ho-kinh-doanh'))
          .statusCode,
      ).toBe(404);
    });

    it('chỉ bài đã phát hành và đã duyệt lộ ra; nháp → 404; kèm dòng không thay tư vấn pháp lý; checklist trỏ tới bài', async () => {
      await art('dang-ky-ho-kinh-doanh', 'Đăng ký hộ kinh doanh', 'published');
      await art('cong-khai-mau-02', 'Công khai Mẫu 02', 'draft');
      const l = await get<LegalArticleViewPage>(teacher, '/legal-articles');
      expect(l.items.map((i) => i.slug)).toEqual(['dang-ky-ho-kinh-doanh']);
      expect(l.items[0]).toMatchObject({
        disclaimer: 'Công cụ hỗ trợ, không thay tư vấn pháp lý',
        reviewedBy: 'LS. Trần Thị Mai',
        reviewerRole: 'lawyer',
        reviewedOn: '2026-12-19',
        sources: [{ title: 'TT29', url: 'https://example.com/tt29' }],
      });
      expect(
        (await call(A, 'GET', '/legal-articles/cong-khai-mau-02')).statusCode,
      ).toBe(404);
      expect(
        (await call(A, 'GET', '/legal-articles/dang-ky-ho-kinh-doanh'))
          .statusCode,
      ).toBe(200);
      const c = await get<ComplianceChecklist>(A, '/compliance/checklist');
      expect(c.items.map((i) => i.legalArticleSlug)).toEqual([
        'dang-ky-ho-kinh-doanh',
        'dang-ky-ho-kinh-doanh',
        null,
        null,
      ]);
    });

    it('tìm không dấu theo tiêu đề; ký tự đại diện LIKE bị vô hiệu; bài đã phát hành là DB chặn nếu thiếu người duyệt', async () => {
      await art(
        'nguong-doanh-thu-500-trieu',
        'Ngưỡng doanh thu năm',
        'published',
        'Cách theo dõi doanh thu.',
      );
      const find = async (s: string) =>
        (
          await get<LegalArticleViewPage>(
            A,
            `/legal-articles?q=${encodeURIComponent(s)}`,
          )
        ).items.map((i) => i.slug);
      expect(await find('ho kinh doanh')).toEqual(['dang-ky-ho-kinh-doanh']);
      expect(await find('NGUONG')).toEqual(['nguong-doanh-thu-500-trieu']);
      expect(await find('theo doi')).toEqual(['nguong-doanh-thu-500-trieu']);
      expect(await find('%')).toEqual([]);
      expect(await find('_')).toEqual([]);
      await expect(
        q(
          `insert into legal_articles (id, slug, title, summary, body_markdown, sources, status, published_at)
           values ($1, 'khong-nguoi-duyet', 'x', 'x', 'x', '[]'::jsonb, 'published', now())`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/legal_articles_published_check/);
    });

    it('phụ huynh → 403; app không ghi được vào bảng', async () => {
      expect((await call(parent, 'GET', '/legal-articles')).statusCode).toBe(
        403,
      );
      expect(
        (await call(parent, 'GET', '/legal-articles/dang-ky-ho-kinh-doanh'))
          .statusCode,
      ).toBe(403);
      const app = new (await import('pg')).default.Pool({
        connectionString: t.db.url('teachhub_app'),
      });
      await expect(
        app.query(
          `insert into legal_articles (id, slug, title, summary, body_markdown, sources) values (gen_random_uuid(), 'x', 'x', 'x', 'x', '[]')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await app.end();
    });

    it('cảnh báo ngưỡng trỏ tới bài đã phát hành, chưa có bài thì null', async () => {
      const b = await book(A);
      expect(
        b.alerts.find((x) => x.milestone === '400m')!.legalArticleSlug,
      ).toBe('nguong-doanh-thu-500-trieu');
      expect(
        b.alerts.find((x) => x.milestone === '800m')!.legalArticleSlug,
      ).toBeNull();
    });
  });

  describe('xác nhận cảnh báo lớp (US-9.3)', () => {
    const mkClass = async (who: Who, subject: string, grade: number) => {
      const r = await call(who, 'POST', '/classes', {
        name: `${subject} ${grade}`,
        subject,
        grade,
        mode: 'online',
        startDate: '2026-12-14',
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json() as { id: string; warnings: { code: string }[] };
    };
    const ack = (
      who: { token: string },
      id: string,
      code = 'TT29_PRIMARY_ACADEMIC',
    ) => call(who, 'POST', `/classes/${id}/warning-acknowledgements`, { code });

    it('lớp văn hóa khối tiểu học có cảnh báo; môn nghệ thuật hoặc khối 6+ thì không', async () => {
      expect((await mkClass(A, 'Toán', 3)).warnings.map((w) => w.code)).toEqual(
        ['TT29_PRIMARY_ACADEMIC'],
      );
      expect((await mkClass(A, 'Vẽ', 3)).warnings).toEqual([]);
      expect((await mkClass(A, 'Toán', 9)).warnings).toEqual([]);
    });

    it('xác nhận: 204, ghi một dòng nhật ký có người xác nhận, gọi lại không ghi trùng', async () => {
      const c = await mkClass(A, 'Tiếng Việt', 2);
      expect((await ack(A, c.id)).statusCode).toBe(204);
      expect((await ack(A, c.id)).statusCode).toBe(204);
      expect(
        await q(
          `select kind, entity_id, code, user_id, tenant_id from acknowledgements where entity_id = $1`,
          [c.id],
        ),
      ).toEqual([
        {
          kind: 'class_warning',
          entity_id: c.id,
          code: 'TT29_PRIMARY_ACADEMIC',
          user_id: A.userId,
          tenant_id: A.tenantId,
        },
      ]);
    });

    it('mã không nằm trong cảnh báo hiện có của lớp → 422 và không ghi', async () => {
      const art = await mkClass(A, 'Âm nhạc', 4);
      const high = await mkClass(A, 'Toán', 10);
      for (const c of [art, high]) {
        const r = await ack(A, c.id);
        expect(r.statusCode).toBe(422);
        expect(r.json().errors).toHaveProperty('code');
      }
      expect((await ack(A, high.id, 'KHAC')).statusCode).toBe(422);
      expect(
        await q(`select 1 from acknowledgements where entity_id = any($1)`, [
          [art.id, high.id],
        ]),
      ).toEqual([]);
    });

    it('chéo tenant: B xác nhận lớp của A → 404, không ghi; phụ huynh 403; lớp lạ 404', async () => {
      const c = await mkClass(A, 'Toán', 1);
      expect((await ack(B, c.id)).statusCode).toBe(404);
      expect((await ack(parent, c.id)).statusCode).toBe(403);
      expect((await ack(A, randomUUID())).statusCode).toBe(404);
      expect(
        await q(`select 1 from acknowledgements where entity_id = $1`, [c.id]),
      ).toEqual([]);
    });
  });
});
