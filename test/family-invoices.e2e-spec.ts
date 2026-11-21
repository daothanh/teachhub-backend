import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Teacher = SeededTenant & { token: string };
type Parent = { userId: string; token: string };
type Item = { id: string; status: string; studentId: string };

const TERMS = '2026-12-01';

// S5-BE-08: /family/invoices: phụ huynh đọc hóa đơn đã phát hành của con (US-7.3 AC1, US-0.6 AC3).
describe('family: hóa đơn của con', () => {
  let t: TestApp;
  let appPool: pg.Pool;
  let A: Teacher;
  let B: Teacher;
  let seq = 0;

  const call = (
    token: string | null,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      },
    });
  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const mkTeacher = async (name: string): Promise<Teacher> => {
    const s = await seedTenant(t.worker);
    await q(`update users set display_name = $2 where id = $1`, [
      s.userId,
      name,
    ]);
    return { ...s, token: await t.tokenFor(s.userId) };
  };
  const mkParent = async (consent = true): Promise<Parent> => {
    const userId = randomUUID();
    await q(
      `insert into users (id, email, display_name) values ($1, $2, 'PH')`,
      [userId, `${userId}@example.com`],
    );
    const token = await t.tokenFor(userId);
    if (consent) {
      await call(token, 'POST', '/consents', {
        role: 'parent',
        termsVersion: TERMS,
      });
    }
    return { userId, token };
  };
  /** Học viên của giáo viên `who`, liên kết với phụ huynh `p` qua lời mời thật. */
  const child = async (who: Teacher, p: Parent, fullName = 'Lê Gia Bảo') => {
    const st = await call(who.token, 'POST', '/students', {
      fullName,
      dob: `2012-${String(1 + (++seq % 12)).padStart(2, '0')}-${String(1 + (seq % 27)).padStart(2, '0')}`,
      notes: 'ghi chú riêng của giáo viên',
      guardians: [
        { fullName: 'Lê Văn A', relation: 'father', phone: '0912345678' },
      ],
    });
    expect(st.statusCode, st.body).toBe(201);
    const s = st.json() as { id: string; guardians: { id: string }[] };
    const inv = await call(who.token, 'POST', `/students/${s.id}/invites`, {
      guardianId: s.guardians[0]!.id,
    });
    const acc = await call(p.token, 'POST', '/invites/accept', {
      token: inv.json().token,
    });
    expect(acc.statusCode, acc.body).toBe(200);
    return { studentId: s.id, guardianId: s.guardians[0]!.id, who };
  };
  /** Hóa đơn của `c` (kỳ riêng, tháng tăng dần); `status` mặc định đã phát hành. */
  const invoice = async (
    c: { studentId: string; who: Teacher },
    o: { status?: string; total?: number; issuedAt?: string } = {},
  ) => {
    seq++;
    const status = o.status ?? 'issued';
    const periodId = randomUUID();
    const id = randomUUID();
    const month = `${2031 + Math.floor(seq / 12)}-${String((seq % 12) + 1).padStart(2, '0')}-01`;
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $3, ($3::date + 9))`,
      [periodId, c.who.tenantId, month],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [id, c.who.tenantId, periodId, c.studentId, o.total ?? 1_200_000],
    );
    await q(
      `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount, class_name, adjustment_reason)
       values ($1, $2, $3, 1, 'monthly', 'Học phí tháng', 1500000, 'Toán 9A', null),
              ($4, $2, $3, 2, 'manual_adjustment', 'Giảm theo thỏa thuận', -300000, null, 'LÝ DO NỘI BỘ')`,
      [randomUUID(), c.who.tenantId, id, randomUUID()],
    );
    if (status !== 'draft') {
      const code = `TH-${String(100000 + seq)}`;
      await q(
        `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = $4,
           payout = '{"bankBin":"970436","bankName":"Vietcombank","accountNo":"0011001234567","accountName":"NGUYEN VAN A"}'::jsonb,
           issued_at = coalesce($5::timestamptz, now()) where id = $1`,
        [
          id,
          code,
          code.replace('-', ' '),
          `000201-${code}`,
          o.issuedAt ?? null,
        ],
      );
    }
    if (status === 'void') {
      await q(
        `update invoices set status = 'void', void_reason = 'LÝ DO HỦY NỘI BỘ', voided_at = now() where id = $1`,
        [id],
      );
    }
    return id;
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
      await c.query('rollback');
      return { rows: r.rows as T[], rowCount: r.rowCount };
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    t = await startTestApp();
    appPool = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    A = await mkTeacher('Cô Lan');
    B = await mkTeacher('Thầy Bình');
  }, 180_000);
  afterAll(async () => {
    await appPool?.end();
    await t?.stop();
  });

  it('danh sách gộp con ở mọi tenant, mới phát hành trước, không bao giờ có nháp; chi tiết đủ kỳ/dòng/tổng/hạn/tài khoản/VietQR', async () => {
    const p = await mkParent();
    const a = await child(A, p, 'Lê Gia Bảo');
    const b = await child(B, p, 'Lê Gia Hân');
    const old = await invoice(a, { issuedAt: '2031-01-02T02:00:00Z' });
    const mid = await invoice(b, { issuedAt: '2031-02-02T02:00:00Z' });
    const newest = await invoice(a, {
      issuedAt: '2031-03-02T02:00:00Z',
      total: 777_000,
    });
    const draft = await invoice(a, { status: 'draft' });

    const res = await call(p.token, 'GET', '/family/invoices');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Item[]; nextCursor: string | null };
    expect(body.items.map((i) => i.id)).toEqual([newest, mid, old]);
    expect(body.items.map((i) => i.id)).not.toContain(draft);
    expect(body.nextCursor).toBeNull();
    expect(body.items[1]).toMatchObject({
      studentName: 'Lê Gia Hân',
      teacherName: 'Thầy Bình',
      status: 'issued',
      totalAmount: 1_200_000,
      issuedAt: '2031-02-02T09:00:00+07:00',
    });

    const det = await call(p.token, 'GET', `/family/invoices/${newest}`);
    expect(det.statusCode, det.body).toBe(200);
    const d = det.json();
    expect(d).toMatchObject({
      id: newest,
      status: 'issued',
      studentName: 'Lê Gia Bảo',
      teacherName: 'Cô Lan',
      totalAmount: 777_000,
      transferNote: expect.stringMatching(/^TH \d{6}$/),
      qrPayload: expect.stringContaining('000201'),
      payout: {
        bankBin: '970436',
        accountNo: '0011001234567',
        accountName: 'NGUYEN VAN A',
      },
      voidedAt: null,
    });
    expect(d.periodMonth).toMatch(/^\d{4}-\d{2}-01$/);
    expect(d.dueDate).toMatch(/^\d{4}-\d{2}-10$/);
    expect(d.lines).toEqual([
      {
        kind: 'monthly',
        className: 'Toán 9A',
        description: 'Học phí tháng',
        amount: 1_500_000,
      },
      {
        kind: 'manual_adjustment',
        className: null,
        description: 'Giảm theo thỏa thuận',
        amount: -300_000,
      },
    ]);
  });

  it('phân trang con trỏ, lọc status và studentId; con không liên kết cho danh sách rỗng', async () => {
    const p = await mkParent();
    const a = await child(A, p);
    const b = await child(B, p);
    const ids = [
      await invoice(a, { issuedAt: '2032-01-01T00:00:00Z' }),
      await invoice(a, { issuedAt: '2032-01-02T00:00:00Z' }),
      await invoice(b, { issuedAt: '2032-01-03T00:00:00Z', status: 'void' }),
    ];
    const p1 = (await call(p.token, 'GET', '/family/invoices?limit=2')).json();
    expect(p1.items.map((i: Item) => i.id)).toEqual([ids[2], ids[1]]);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = (
      await call(
        p.token,
        'GET',
        `/family/invoices?limit=2&cursor=${p1.nextCursor}`,
      )
    ).json();
    expect(p2.items.map((i: Item) => i.id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeNull();

    const voids = (
      await call(p.token, 'GET', '/family/invoices?status=void')
    ).json();
    expect(voids.items.map((i: Item) => i.id)).toEqual([ids[2]]);
    const ofA = (
      await call(p.token, 'GET', `/family/invoices?studentId=${a.studentId}`)
    ).json();
    expect(ofA.items.map((i: Item) => i.id)).toEqual([ids[1], ids[0]]);
    const other = await mkParent();
    await child(B, other);
    const none = await call(
      other.token,
      'GET',
      `/family/invoices?studentId=${a.studentId}`,
    );
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ items: [], nextCursor: null });

    expect(
      (await call(p.token, 'GET', '/family/invoices?status=draft')).statusCode,
    ).toBe(422);
    expect(
      (await call(p.token, 'GET', '/family/invoices?cursor=xyz')).statusCode,
    ).toBe(422);
  });

  it('hóa đơn đã hủy: vẫn xem được với status void, không QR, không tài khoản nhận, không lý do hủy', async () => {
    const p = await mkParent();
    const a = await child(A, p);
    const id = await invoice(a, { status: 'void' });
    const det = await call(p.token, 'GET', `/family/invoices/${id}`);
    expect(det.statusCode, det.body).toBe(200);
    expect(det.json()).toMatchObject({
      status: 'void',
      qrPayload: null,
      payout: null,
    });
    expect(det.json().voidedAt).toMatch(/\+07:00$/);
    const list = (await call(p.token, 'GET', '/family/invoices')).json();
    expect(list.items).toMatchObject([{ id, status: 'void' }]);
    expect(det.body + JSON.stringify(list)).not.toMatch(
      /HỦY NỘI BỘ|voidReason|void_reason/,
    );
  });

  it('không lộ trường nội bộ (ghi chú giáo viên, lý do điều chỉnh, kẹp tiền, audit)', async () => {
    const p = await mkParent();
    const a = await child(A, p);
    const id = await invoice(a);
    const det = await call(p.token, 'GET', `/family/invoices/${id}`);
    const list = await call(p.token, 'GET', '/family/invoices');
    const all = det.body + list.body;
    expect(all).not.toMatch(
      /LÝ DO NỘI BỘ|adjustmentReason|clampedAmount|ghi chú riêng|0912345678|replac|tenantId|createdAt/,
    );
  });

  it('cô lập: phụ huynh Y không xem được hóa đơn của con X (cùng/khác tenant); nháp và id lạ cùng 404', async () => {
    const x = await mkParent();
    const y = await mkParent();
    const cx = await child(A, x);
    await child(A, y); // Y cùng tenant A
    await child(B, y); // và tenant B
    const inv = await invoice(cx);
    const draft = await invoice(cx, { status: 'draft' });
    const own = await call(x.token, 'GET', `/family/invoices/${inv}`);
    expect(own.statusCode).toBe(200);
    const notFound = await call(y.token, 'GET', `/family/invoices/${inv}`);
    expect(notFound.statusCode).toBe(404);
    for (const id of [draft, randomUUID()]) {
      const r = await call(x.token, 'GET', `/family/invoices/${id}`);
      expect(r.statusCode, id).toBe(404);
      expect(r.json().code).toBe('NOT_FOUND');
    }
    // 404 của Y có đúng thân với id không tồn tại (không phân biệt được).
    const ghost = await call(
      y.token,
      'GET',
      `/family/invoices/${randomUUID()}`,
    );
    expect({ ...notFound.json(), requestId: 0 }).toEqual({
      ...ghost.json(),
      requestId: 0,
    });
    expect(
      (await call(y.token, 'GET', '/family/invoices')).json().items,
    ).toEqual([]);
    expect(
      (await call(x.token, 'GET', '/family/invoices/not-a-uuid')).statusCode,
    ).toBe(422);
  });

  it('con bị gỡ liên kết hoặc đã left không còn thấy hóa đơn', async () => {
    const p = await mkParent();
    const c1 = await child(A, p);
    const c2 = await child(B, p);
    const i1 = await invoice(c1);
    const i2 = await invoice(c2);
    await q(`update guardians set deleted_at = now() where id = $1`, [
      c1.guardianId,
    ]);
    await q(`update students set status = 'left' where id = $1`, [
      c2.studentId,
    ]);
    expect(
      (await call(p.token, 'GET', `/family/invoices/${i1}`)).statusCode,
    ).toBe(404);
    expect(
      (await call(p.token, 'GET', `/family/invoices/${i2}`)).statusCode,
    ).toBe(404);
    expect(
      (await call(p.token, 'GET', '/family/invoices')).json().items,
    ).toEqual([]);
  });

  it('giáo viên và học sinh 403; chưa đăng nhập 401; chưa đồng ý điều khoản 403 CONSENT_REQUIRED', async () => {
    const x = await mkParent();
    const c = await child(A, x);
    const id = await invoice(c);
    for (const url of ['/family/invoices', `/family/invoices/${id}`]) {
      expect((await call(A.token, 'GET', url)).statusCode, url).toBe(403);
      expect((await call(null, 'GET', url)).statusCode, url).toBe(401);
    }
    const userId = randomUUID();
    await q(
      `insert into users (id, email, display_name) values ($1, $2, 'HS')`,
      [userId, `${userId}@example.com`],
    );
    await q(
      `insert into memberships (id, user_id, role, student_id) values ($1, $2, 'student', $3)`,
      [randomUUID(), userId, c.studentId],
    );
    const student = await t.tokenFor(userId);
    for (const url of ['/family/invoices', `/family/invoices/${id}`]) {
      expect((await call(student, 'GET', url)).statusCode, url).toBe(403);
    }
    const nc = await mkParent(false);
    expect(
      (await call(nc.token, 'POST', '/me/roles', { role: 'parent' }))
        .statusCode,
    ).toBe(201);
    for (const url of [
      '/family/invoices',
      `/family/invoices/${id}`,
      `/family/invoices/${randomUUID()}`,
    ]) {
      const r = await call(nc.token, 'GET', url);
      expect(r.statusCode, url).toBe(403);
      expect(r.json()).toMatchObject({
        code: 'CONSENT_REQUIRED',
        details: { termsVersion: TERMS },
      });
    }
  });

  it('RLS trực tiếp: phụ huynh chỉ đọc hóa đơn/dòng/kỳ không nháp của con mình, không ghi được', async () => {
    const x = await mkParent();
    const y = await mkParent();
    const cx = await child(A, x);
    await child(B, y);
    const inv = await invoice(cx);
    const draft = await invoice(cx, { status: 'draft' });
    const seen = await asUser<{ id: string }>(
      x.userId,
      `select id from invoices where student_id = $1`,
      [cx.studentId],
    );
    expect(seen.rows.map((r) => r.id)).toEqual([inv]);
    expect(
      (
        await asUser(
          x.userId,
          `select 1 from invoice_lines where invoice_id = $1`,
          [draft],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await asUser(
          x.userId,
          `select 1 from invoice_lines where invoice_id = $1`,
          [inv],
        )
      ).rows,
    ).toHaveLength(2);
    expect(
      (
        await asUser(
          x.userId,
          `select 1 from billing_periods where tenant_id = $1`,
          [A.tenantId],
        )
      ).rows,
    ).toHaveLength(1);
    for (const u of [y.userId, B.userId]) {
      expect(
        (await asUser(u, `select 1 from invoices where id = $1`, [inv])).rows,
        u,
      ).toEqual([]);
    }
    expect(
      (
        await asUser(
          y.userId,
          `select 1 from invoice_lines where invoice_id = $1`,
          [inv],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await asUser(
          y.userId,
          `select 1 from billing_periods where tenant_id = $1`,
          [A.tenantId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await asUser(
          x.userId,
          `update invoices set total_amount = 1 where id = $1`,
          [inv],
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      asUser(x.userId, `delete from invoice_lines where invoice_id = $1`, [
        inv,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});
