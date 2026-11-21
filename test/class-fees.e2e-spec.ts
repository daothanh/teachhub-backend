import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S5-BE-02 [money] [tenant-isolation]: học phí lớp (US-1.2) và mức riêng học viên (US-1.3).
describe('[money][tenant-isolation] học phí lớp + mức riêng học viên', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;

  const call = (
    who: { token: string },
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: object,
    key: string = randomUUID(),
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': key }),
      },
    });
  const newClass = async (who: Who, over: object = {}) => {
    const res = await call(who, 'POST', '/classes', {
      name: 'Toán 9A',
      subject: 'Toán',
      grade: 9,
      mode: 'online',
      startDate: '2026-12-14',
      ...over,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const enrollNew = async (who: Who, classId: string) => {
    const s = await call(who, 'POST', '/students', {
      fullName: `Học viên ${randomUUID()}`,
    });
    expect(s.statusCode, s.body).toBe(201);
    const e = await call(who, 'POST', `/classes/${classId}/enrollments`, {
      studentId: s.json().id,
    });
    expect(e.statusCode, e.body).toBe(201);
    return {
      studentId: s.json().id as string,
      enrollmentId: e.json().id as string,
    };
  };
  const patch = (who: Who, id: string, body: object) =>
    call(who, 'PATCH', `/classes/${id}`, body);
  const feeCols = async (id: string) =>
    (
      await t.worker.query(
        `select fee_type, fee_amount, fee_rules from classes where id = $1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
  }, 180_000);
  afterAll(() => t?.stop());

  it('AC-1: lưu từng kiểu per_session | monthly; GET chi tiết và danh sách trả đủ feeType, feeAmount, feeRules', async () => {
    const id = await newClass(A);
    expect((await call(A, 'GET', `/classes/${id}`)).json()).toMatchObject({
      feeType: null,
      feeAmount: null,
      feeRules: null,
    });
    const r1 = await patch(A, id, {
      feeType: 'per_session',
      feeAmount: 150000,
    });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({
      feeType: 'per_session',
      feeAmount: 150000,
    });
    const r2 = await patch(A, id, { feeType: 'monthly', feeAmount: 1200000 });
    expect(r2.json()).toMatchObject({ feeType: 'monthly', feeAmount: 1200000 });
    const get = (await call(A, 'GET', `/classes/${id}`)).json();
    expect(get).toMatchObject({ feeType: 'monthly', feeAmount: 1200000 });
    const list = (await call(A, 'GET', '/classes')).json().items as {
      id: string;
      feeType: string;
    }[];
    expect(list.find((c) => c.id === id)).toMatchObject({
      feeType: 'monthly',
      feeAmount: 1200000,
      feeRules: { chargeExcused: true },
    });
  });

  it('AC-1: course cần endDate và quy tắc lịch, thiếu → 422 ở feeType; đủ thì lưu', async () => {
    const id = await newClass(A, { name: 'Luyện thi' });
    const noEnd = await patch(A, id, { feeType: 'course', feeAmount: 9000000 });
    expect(noEnd.statusCode).toBe(422);
    expect(noEnd.json().code).toBe('VALIDATION_FAILED');
    expect(Object.keys(noEnd.json().errors)).toEqual(['feeType']);
    await patch(A, id, { endDate: '2027-03-31' });
    const noRule = await patch(A, id, {
      feeType: 'course',
      feeAmount: 9000000,
    });
    expect(Object.keys(noRule.json().errors)).toEqual(['feeType']);
    expect((await feeCols(id)).fee_type).toBeNull();

    const sr = await call(A, 'PUT', `/classes/${id}/schedule-rules`, {
      rules: [{ weekday: 2, startTime: '18:00', durationMin: 90 }],
    });
    expect(sr.statusCode, sr.body).toBe(200);
    const ok = await patch(A, id, {
      feeType: 'course',
      feeAmount: 9000000,
      feeRules: { installments: 3 },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      feeType: 'course',
      feeAmount: 9000000,
      feeRules: { installments: 3 },
    });
    // bỏ endDate của lớp trọn khóa → lỗi, không để lớp course mất kỳ hạn
    const drop = await patch(A, id, { endDate: null });
    expect(drop.statusCode).toBe(422);
  });

  it('AC-1: feeAmount nguyên > 0; feeType và feeAmount cùng null thì xóa cấu hình; chỉ một trong hai → 422', async () => {
    const id = await newClass(A);
    for (const bad of [0, -5, 1.5]) {
      const r = await patch(A, id, { feeType: 'per_session', feeAmount: bad });
      expect(r.statusCode, `feeAmount=${bad}`).toBe(422);
    }
    expect((await feeCols(id)).fee_type).toBeNull();
    await patch(A, id, {
      feeType: 'per_session',
      feeAmount: 100000,
      feeRules: { chargeExcused: false },
    });
    const half = await patch(A, id, { feeType: null });
    expect(half.statusCode).toBe(422);
    const cleared = await patch(A, id, { feeType: null, feeAmount: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({
      feeType: null,
      feeAmount: null,
      feeRules: null,
    });
    expect(await feeCols(id)).toEqual({
      fee_type: null,
      fee_amount: null,
      fee_rules: null,
    });
    // feeRules khi lớp không có học phí → 422
    const noFee = await patch(A, id, { feeRules: { chargeExcused: false } });
    expect(noFee.statusCode).toBe(422);
  });

  it('AC-2: feeRules mặc định bật cả hai loại vắng; tắt được từng cái; thiếu trường lấy mặc định; PATCH không gửi feeRules thì giữ', async () => {
    const id = await newClass(A);
    const def = await patch(A, id, {
      feeType: 'per_session',
      feeAmount: 100000,
    });
    expect(def.json().feeRules).toEqual({
      chargeExcused: true,
      chargeUnexcused: true,
      deductCancelled: false,
      installments: 1,
    });
    const r1 = await patch(A, id, { feeRules: { chargeExcused: false } });
    expect(r1.json().feeRules).toMatchObject({
      chargeExcused: false,
      chargeUnexcused: true,
    });
    // thay toàn bộ: chargeExcused trở lại mặc định
    const r2 = await patch(A, id, { feeRules: { chargeUnexcused: false } });
    expect(r2.json().feeRules).toMatchObject({
      chargeExcused: true,
      chargeUnexcused: false,
    });
    // đổi số tiền, không gửi feeRules → giữ quy tắc
    const r3 = await patch(A, id, { feeAmount: 120000 });
    expect(r3.json().feeRules).toMatchObject({ chargeUnexcused: false });
    // null → về mặc định
    const r4 = await patch(A, id, { feeRules: null });
    expect(r4.json().feeRules).toMatchObject({ chargeUnexcused: true });
    // chia đợt cho lớp không phải trọn khóa → 422
    const bad = await patch(A, id, { feeRules: { installments: 3 } });
    expect(bad.statusCode).toBe(422);
  });

  it('AC-3: đổi cấu hình học phí không đụng hóa đơn đã phát hành và dòng hóa đơn', async () => {
    const id = await newClass(A, { name: 'Lý 10' });
    const { studentId } = await enrollNew(A, id);
    await patch(A, id, { feeType: 'monthly', feeAmount: 1000000 });
    const period = randomUUID();
    const inv = randomUUID();
    await t.worker.query(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date)
       values ($1, $2, '2026-12-01', '2026-12-31', '2027-01-10')`,
      [period, A.tenantId],
    );
    await t.worker.query(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1,$2,$3,$4,1000000)`,
      [inv, A.tenantId, period, studentId],
    );
    await t.worker.query(
      `insert into invoice_lines (id, tenant_id, invoice_id, position, kind, description, amount)
       values ($1,$2,$3,1,'monthly','Học phí tháng 12',1000000)`,
      [randomUUID(), A.tenantId, inv],
    );
    await t.worker.query(
      `update invoices set status='issued', code='TH-25K7Q9', transfer_note='TH 25K7Q9', qr_payload='000201',
       payout='{"bankBin":"970436","accountNo":"0123456789","accountName":"A"}'::jsonb, issued_at=now() where id=$1`,
      [inv],
    );
    const snap = async () =>
      JSON.stringify(
        (
          await t.worker.query(
            `select i.*, (select json_agg(l order by position) from invoice_lines l where l.invoice_id = i.id) as lines
             from invoices i where i.id = $1`,
            [inv],
          )
        ).rows,
      );
    const before = await snap();
    for (const body of [
      { feeAmount: 2000000 },
      { feeType: 'per_session', feeAmount: 200000 },
      { feeRules: { chargeExcused: false } },
      { feeType: null, feeAmount: null },
    ]) {
      expect((await patch(A, id, body)).statusCode).toBe(200);
    }
    expect(await snap()).toBe(before);
  });

  it('AC-4: PUT fee-override lưu mức riêng, quy tắc vắng riêng, miễn giảm; {} xóa; thay toàn bộ', async () => {
    const classId = await newClass(A, { name: 'Hóa 11' });
    await patch(A, classId, { feeType: 'per_session', feeAmount: 150000 });
    const { enrollmentId, studentId } = await enrollNew(A, classId);
    const put = (body: object) =>
      call(A, 'PUT', `/enrollments/${enrollmentId}/fee-override`, body);

    const r1 = await put({
      feeAmount: 120000,
      chargeExcused: false,
      discounts: [{ kind: 'percent', description: 'Con GV', percent: 10 }],
    });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toEqual({
      enrollmentId,
      studentId,
      classId,
      feeOverride: {
        feeAmount: 120000,
        chargeExcused: false,
        chargeUnexcused: null,
        deductCancelled: null,
        installments: null,
        discounts: [{ kind: 'percent', description: 'Con GV', percent: 10 }],
      },
    });
    // Lưu dạng hợp đồng, null = kế thừa lớp (học sinh > lớp > mặc định do InvoiceCalculator áp).
    const stored = (
      await t.worker.query(`select fee_override from enrollments where id=$1`, [
        enrollmentId,
      ])
    ).rows[0].fee_override;
    expect(stored).toMatchObject({ feeAmount: 120000, chargeUnexcused: null });

    // chỉ miễn giảm cũng là mức riêng
    const r2 = await put({
      discounts: [{ kind: 'amount', description: 'Hỗ trợ', amount: 50000 }],
    });
    expect(r2.json().feeOverride).toMatchObject({
      feeAmount: null,
      discounts: [{ kind: 'amount', amount: 50000 }],
    });
    // {} xóa mức riêng
    const r3 = await put({});
    expect(r3.statusCode).toBe(200);
    expect(r3.json().feeOverride).toBeNull();
    expect(
      (
        await t.worker.query(
          `select fee_override from enrollments where id=$1`,
          [enrollmentId],
        )
      ).rows[0].fee_override,
    ).toBeNull();
  });

  it('AC-4: feeAmount đòi lớp có học phí; installments > 1 chỉ cho trọn khóa; > 5 khoản miễn giảm → 422', async () => {
    const classId = await newClass(A, { name: 'Sinh 12' });
    const { enrollmentId } = await enrollNew(A, classId);
    const put = (body: object) =>
      call(A, 'PUT', `/enrollments/${enrollmentId}/fee-override`, body);
    const noFee = await put({ feeAmount: 100000 });
    expect(noFee.statusCode).toBe(422);
    expect(Object.keys(noFee.json().errors)).toEqual(['feeAmount']);
    await patch(A, classId, { feeType: 'monthly', feeAmount: 1000000 });
    const inst = await put({ installments: 3 });
    expect(inst.statusCode).toBe(422);
    expect(Object.keys(inst.json().errors)).toEqual(['installments']);
    const many = await put({
      discounts: Array.from({ length: 6 }, () => ({
        kind: 'amount',
        description: 'x',
        amount: 1000,
      })),
    });
    expect(many.statusCode).toBe(422);
  });

  it('AC-4: ghi danh đã rời lớp → 409 CONFLICT_STALE; id lạ → 404', async () => {
    const classId = await newClass(A, { name: 'Anh 7' });
    const { enrollmentId } = await enrollNew(A, classId);
    await t.worker.query(
      `update enrollments set left_on = joined_on where id = $1`,
      [enrollmentId],
    );
    const res = await call(
      A,
      'PUT',
      `/enrollments/${enrollmentId}/fee-override`,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT_STALE');
    const none = await call(
      A,
      'PUT',
      `/enrollments/${randomUUID()}/fee-override`,
      {},
    );
    expect(none.statusCode).toBe(404);
  });

  it('AC-5: roster trả feeOverride khác null khi có mức riêng / quy tắc riêng / miễn giảm, null khi theo lớp', async () => {
    const classId = await newClass(A, { name: 'Văn 9' });
    await patch(A, classId, { feeType: 'per_session', feeAmount: 100000 });
    const mk = async (name: string) => {
      const s = await call(A, 'POST', '/students', { fullName: name });
      const e = await call(A, 'POST', `/classes/${classId}/enrollments`, {
        studentId: s.json().id,
      });
      return e.json().id as string;
    };
    const [e1, e2, e3, e4] = [
      await mk('An'),
      await mk('Bình'),
      await mk('Chi'),
      await mk('Dung'),
    ];
    const put = (id: string, body: object) =>
      call(A, 'PUT', `/enrollments/${id}/fee-override`, body);
    await put(e1, { feeAmount: 80000 });
    await put(e2, { chargeUnexcused: false });
    await put(e3, {
      discounts: [{ kind: 'percent', description: 'Miễn giảm', percent: 100 }],
    });
    await put(e4, { feeAmount: 80000 });
    await put(e4, {}); // xóa → lại theo lớp
    const roster = (await call(A, 'GET', `/classes/${classId}/roster`)).json()
      .items as { enrollmentId: string; feeOverride: unknown }[];
    const by = (id: string) => roster.find((r) => r.enrollmentId === id)!;
    expect(by(e1).feeOverride).toMatchObject({ feeAmount: 80000 });
    expect(by(e2).feeOverride).toMatchObject({ chargeUnexcused: false });
    expect(by(e3).feeOverride).toMatchObject({
      discounts: [{ kind: 'percent', percent: 100 }],
    });
    expect(by(e4).feeOverride).toBeNull();
  });

  it('cô lập tenant: B không sửa học phí lớp của A (404, không đổi) và không đặt mức riêng cho ghi danh của A', async () => {
    const classId = await newClass(A, { name: 'Cô lập' });
    await patch(A, classId, { feeType: 'monthly', feeAmount: 500000 });
    const { enrollmentId } = await enrollNew(A, classId);
    const before = await feeCols(classId);

    const r1 = await patch(B, classId, {
      feeType: 'per_session',
      feeAmount: 1,
    });
    expect(r1.statusCode).toBe(404);
    expect(await feeCols(classId)).toEqual(before);

    const r2 = await call(
      B,
      'PUT',
      `/enrollments/${enrollmentId}/fee-override`,
      {
        discounts: [{ kind: 'percent', description: 'x', percent: 100 }],
      },
    );
    expect(r2.statusCode).toBe(404);
    expect(
      (
        await t.worker.query(
          `select fee_override from enrollments where id=$1`,
          [enrollmentId],
        )
      ).rows[0].fee_override,
    ).toBeNull();
    // B không thấy học phí của A trong danh sách
    expect((await call(B, 'GET', '/classes')).json().total).toBe(0);
  });

  it('vai trò: chỉ tenant_owner ghi học phí và mức riêng (teacher → 403)', async () => {
    const teacher = await seedMember(t.worker, A.tenantId, 'teacher');
    const who = { token: await t.tokenFor(teacher) };
    const classId = await newClass(A, { name: 'Vai trò' });
    const { enrollmentId } = await enrollNew(A, classId);
    const r1 = await call(who, 'PATCH', `/classes/${classId}`, {
      feeType: 'monthly',
      feeAmount: 1,
    });
    expect(r1.statusCode).toBe(403);
    const r2 = await call(
      who,
      'PUT',
      `/enrollments/${enrollmentId}/fee-override`,
      {},
    );
    expect(r2.statusCode).toBe(403);
  });
});
