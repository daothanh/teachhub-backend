import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

// S2-BE-03: module classes (US-1.1 AC1-AC3) + cách ly tenant ở lớp API.
describe('classes API', () => {
  let t: TestApp;
  let A: SeededTenant & { token: string };
  let B: SeededTenant & { token: string };

  const call = (
    who: { token: string },
    method: 'GET' | 'POST' | 'PATCH',
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
  const body = (over: object = {}) => ({
    name: 'Toán 9A',
    subject: 'Toán',
    grade: 9,
    mode: 'offline',
    location: 'Nhà riêng, 12 Trần Phú',
    capacity: 20,
    startDate: '2026-12-14',
    ...over,
  });

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async () => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
  }, 180_000);
  afterAll(() => t?.stop());

  it('AC1: tạo lớp đủ trường → 201, lớp hiện trong danh sách với 0 học viên và chưa có lịch', async () => {
    const res = await call(A, 'POST', '/classes', body());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'Toán 9A',
      grade: 9,
      mode: 'offline',
      location: 'Nhà riêng, 12 Trần Phú',
      capacity: 20,
      startDate: '2026-12-14',
      endDate: null,
      status: 'active',
      enrolledCount: 0,
      scheduleRules: [],
      warnings: [],
    });
    const list = await call(A, 'GET', '/classes');
    expect(list.json()).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(list.json().items[0].id).toBe(res.json().id);
  });

  it('AC2: tại chỗ thiếu địa điểm, ngày kết thúc trước ngày bắt đầu, thiếu tên → 422 theo trường', async () => {
    const r1 = await call(A, 'POST', '/classes', body({ location: null }));
    expect(r1.statusCode).toBe(422);
    expect(Object.keys(r1.json().errors)).toEqual(['location']);
    const r2 = await call(
      A,
      'POST',
      '/classes',
      body({ endDate: '2026-12-01' }),
    );
    expect(Object.keys(r2.json().errors)).toEqual(['endDate']);
    const r3 = await call(A, 'POST', '/classes', body({ name: '  ' }));
    expect(Object.keys(r3.json().errors)).toEqual(['name']);
    const online = await call(
      A,
      'POST',
      '/classes',
      body({ name: 'Anh 6', mode: 'online', location: null }),
    );
    expect(online.statusCode).toBe(201);
  });

  it('PATCH: gộp với bản hiện có rồi kiểm lại; chỉ đổi trường gửi lên', async () => {
    const id = (
      await call(A, 'POST', '/classes', body({ name: 'Lý 10' }))
    ).json().id;
    const ok = await call(A, 'PATCH', `/classes/${id}`, {
      capacity: 25,
      endDate: '2027-05-31',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      name: 'Lý 10',
      capacity: 25,
      endDate: '2027-05-31',
    });
    // endDate: null = bỏ kỳ hạn
    expect(
      (await call(A, 'PATCH', `/classes/${id}`, { endDate: null })).json()
        .endDate,
    ).toBeNull();
    // đổi ngày bắt đầu vượt endDate cũ → lỗi trên bản gộp
    await call(A, 'PATCH', `/classes/${id}`, { endDate: '2027-01-01' });
    const bad = await call(A, 'PATCH', `/classes/${id}`, {
      startDate: '2027-02-01',
    });
    expect(bad.statusCode).toBe(422);
    expect(Object.keys(bad.json().errors)).toEqual(['endDate']);
    // online -> offline mà xóa địa điểm
    const bad2 = await call(A, 'PATCH', `/classes/${id}`, { location: null });
    expect(bad2.statusCode).toBe(422);
    expect(Object.keys(bad2.json().errors)).toEqual(['location']);
  });

  it('AC3: lưu trữ lớp → ẩn khỏi danh sách active, hiện ở archived; gọi lại vẫn 200 cùng lớp', async () => {
    const id = (
      await call(A, 'POST', '/classes', body({ name: 'Hóa 8' }))
    ).json().id;
    const r1 = await call(A, 'POST', `/classes/${id}/archive`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().status).toBe('archived');
    const r2 = await call(A, 'POST', `/classes/${id}/archive`);
    expect(r2.statusCode).toBe(200);
    const active = (await call(A, 'GET', '/classes?pageSize=100')).json().items;
    expect(active.map((c: { id: string }) => c.id)).not.toContain(id);
    const arch = (await call(A, 'GET', '/classes?status=archived')).json()
      .items;
    expect(arch.map((c: { id: string }) => c.id)).toEqual([id]);
    const { rows } = await t.worker.query(
      `select count(*)::int n from audit_logs where entity = 'classes' and entity_id = $1 and action = 'update'`,
      [id],
    );
    expect(rows[0].n).toBe(1); // lần lưu trữ thứ hai không ghi thêm
  });

  it('tenant B không xem/sửa/lưu trữ lớp của A → 404, lớp A không đổi; danh sách B trống', async () => {
    const id = (
      await call(A, 'POST', '/classes', body({ name: 'Văn 7' }))
    ).json().id;
    expect((await call(B, 'GET', `/classes/${id}`)).statusCode).toBe(404);
    expect(
      (await call(B, 'PATCH', `/classes/${id}`, { name: 'Hack' })).statusCode,
    ).toBe(404);
    const arch = await call(B, 'POST', `/classes/${id}/archive`);
    expect(arch.statusCode).toBe(404);
    expect(arch.json().code).toBe('NOT_FOUND');
    expect((await call(B, 'GET', '/classes')).json()).toMatchObject({
      total: 0,
      items: [],
    });
    const own = (await call(A, 'GET', `/classes/${id}`)).json();
    expect(own).toMatchObject({ name: 'Văn 7', status: 'active' });
  });

  it('id client gửi trùng id lớp của tenant khác → 409, không lộ và không ghi đè', async () => {
    const id = (
      await call(A, 'POST', '/classes', body({ name: 'Sử 8' }))
    ).json().id;
    const res = await call(B, 'POST', '/classes', body({ id }));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT_STALE');
    expect((await call(A, 'GET', `/classes/${id}`)).json().name).toBe('Sử 8');
  });

  it('gửi lặp cùng Idempotency-Key → một lớp, phản hồi phát lại', async () => {
    const key = randomUUID();
    const r1 = await call(A, 'POST', '/classes', body({ name: 'Địa 9' }), key);
    const r2 = await call(A, 'POST', '/classes', body({ name: 'Địa 9' }), key);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json().id).toBe(r1.json().id);
    const { rows } = await t.worker.query(
      `select count(*)::int n from classes where tenant_id = $1 and name = 'Địa 9'`,
      [A.tenantId],
    );
    expect(rows[0].n).toBe(1);
    expect((await call(A, 'POST', '/classes', body(), null)).statusCode).toBe(
      422,
    );
  });

  it('user không có vai trò nhân sự → 403', async () => {
    const userId = randomUUID();
    await t.worker.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    const res = await call(
      { token: await t.tokenFor(userId) },
      'GET',
      '/classes',
    );
    expect(res.statusCode).toBe(403);
  });

  it('PATCH lớp đã lưu trữ → 409 CONFLICT_STALE, lớp không đổi', async () => {
    const id = (
      await call(A, 'POST', '/classes', body({ name: 'Văn 7' }))
    ).json().id;
    await call(A, 'POST', `/classes/${id}/archive`);
    const res = await call(A, 'PATCH', `/classes/${id}`, { name: 'Đổi tên' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT_STALE');
    expect((await call(A, 'GET', `/classes/${id}`)).json().name).toBe('Văn 7');
  });

  it('cùng Idempotency-Key nhưng khác lớp trên đường dẫn → 422 IDEMPOTENCY_KEY_REUSED, không phát lại phản hồi của lớp kia', async () => {
    const [c1, c2] = await Promise.all(
      ['Sử 6', 'Địa 6'].map(
        async (name) =>
          (await call(A, 'POST', '/classes', body({ name }))).json()
            .id as string,
      ),
    );
    const key = randomUUID();
    const r1 = await call(A, 'POST', `/classes/${c1}/archive`, undefined, key);
    expect(r1.statusCode).toBe(200);
    const r2 = await call(A, 'POST', `/classes/${c2}/archive`, undefined, key);
    expect(r2.statusCode).toBe(422);
    expect(r2.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await call(A, 'GET', `/classes/${c2}`)).json().status).toBe(
      'active',
    );
    // cùng key + cùng lớp vẫn phát lại
    const r3 = await call(A, 'POST', `/classes/${c1}/archive`, undefined, key);
    expect(r3.headers['idempotent-replayed']).toBe('true');
  });
});
