import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S2-BE-05: module students (US-1.4 AC1, AC4) + cách ly tenant ở lớp API.
describe('students API', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;

  const call = (
    who: Who,
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
  const add = async (who: Who, payload: object) => {
    const res = await call(who, 'POST', '/students', payload);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };
  const guardianRows = async (studentId: string) =>
    (
      await t.worker.query(
        `select id, full_name, deleted_at is not null as removed from guardians where student_id = $1 order by created_at, id`,
        [studentId],
      )
    ).rows;

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
  }, 180_000);
  afterAll(() => t?.stop());

  it('AC1: chỉ họ tên là bắt buộc; có SĐT phụ huynh thì lưu vào guardians', async () => {
    const bare = await add(A, { fullName: 'Lê Thị Hoa' });
    expect(bare).toMatchObject({
      fullName: 'Lê Thị Hoa',
      dob: null,
      status: 'active',
      guardians: [],
    });
    const full = await add(A, {
      fullName: 'Nguyễn Minh Anh',
      dob: '2011-05-20',
      school: 'THCS Lê Lợi',
      schoolClass: '9A3',
      guardians: [
        { fullName: 'Nguyễn Văn Hải', relation: 'father', phone: '0912345678' },
      ],
    });
    expect(full.guardians).toHaveLength(1);
    expect(full.guardians[0]).toMatchObject({
      fullName: 'Nguyễn Văn Hải',
      relation: 'father',
      phone: '0912345678',
      email: null,
    });
    expect(
      (await call(A, 'POST', '/students', { fullName: ' ' })).statusCode,
    ).toBe(422);
  });

  it('tìm không dấu, không phân biệt hoa thường; q dưới 2 ký tự → 422; ký tự LIKE không thành ký tự đại diện', async () => {
    await add(A, { fullName: 'Trần Đức Thắng' });
    const names = async (q: string) =>
      (await call(A, 'GET', `/students?q=${encodeURIComponent(q)}`))
        .json()
        .items.map((s: { fullName: string }) => s.fullName);
    expect(await names('nguyen minh')).toEqual(['Nguyễn Minh Anh']);
    expect(await names('DUC THANG')).toEqual(['Trần Đức Thắng']);
    expect(await names('Đức')).toEqual(['Trần Đức Thắng']);
    expect(await names('zz')).toEqual([]);
    expect(await names('%%')).toEqual([]);
    expect(await names('__')).toEqual([]);
    const short = await call(A, 'GET', '/students?q=a');
    expect(short.statusCode).toBe(422);
    const all = (await call(A, 'GET', '/students')).json();
    expect(all.total).toBe(all.items.length);
  });

  it('AC4: trùng họ tên + ngày sinh → 409 kèm ứng viên; confirmNew tạo được; khác ngày sinh thì không hỏi', async () => {
    const orig = await add(A, {
      fullName: 'Phạm Gia Bảo',
      dob: '2012-01-02',
      school: 'THCS Nguyễn Du',
    });
    const dup = {
      fullName: '  pham gia BAO ',
      dob: '2012-01-02',
    };
    const res = await call(A, 'POST', '/students', dup);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'STUDENT_POSSIBLE_DUPLICATE',
      details: {
        candidates: [
          {
            id: orig.id,
            fullName: 'Phạm Gia Bảo',
            dob: '2012-01-02',
            school: 'THCS Nguyễn Du',
          },
        ],
      },
    });
    const n = () =>
      t.worker
        .query(
          `select count(*)::int n from students where tenant_id = $1 and full_name_unaccent = 'pham gia bao'`,
          [A.tenantId],
        )
        .then((r) => r.rows[0].n);
    expect(await n()).toBe(1); // 409 không tạo gì
    const forced = await call(A, 'POST', '/students', {
      ...dup,
      confirmNew: true,
    });
    expect(forced.statusCode).toBe(201);
    expect(await n()).toBe(2);
    expect(
      (await call(A, 'POST', '/students', { ...dup, dob: '2012-01-03' }))
        .statusCode,
    ).toBe(201);
    // không ngày sinh chỉ trùng với hồ sơ cũng không có ngày sinh
    expect(
      (await call(A, 'POST', '/students', { fullName: 'Phạm Gia Bảo' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await call(A, 'POST', '/students', { fullName: 'Phạm Gia Bảo' }))
        .statusCode,
    ).toBe(409);
  });

  it('ứng viên trùng tối đa 5 và chỉ trong tenant: hồ sơ cùng tên + ngày sinh ở tenant khác không lộ', async () => {
    const p = { fullName: 'Vũ Hải Đăng', dob: '2010-10-10' };
    for (let i = 0; i < 7; i++) await add(A, { ...p, confirmNew: true });
    const other = await add(B, p); // tenant B: không bị coi là trùng với A
    const res = await call(A, 'POST', '/students', p);
    expect(res.statusCode).toBe(409);
    const ids = res.json().details.candidates.map((c: { id: string }) => c.id);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain(other.id);
    // B có đúng một hồ sơ cùng tên nên B cũng bị hỏi, chỉ thấy hồ sơ của B
    const resB = await call(B, 'POST', '/students', p);
    expect(
      resB.json().details.candidates.map((c: { id: string }) => c.id),
    ).toEqual([other.id]);
  });

  it('PATCH guardians: có id thì cập nhật, không id tạo mới, vắng thì gỡ; không gửi guardians thì giữ nguyên', async () => {
    const s = await add(A, {
      fullName: 'Hoàng Mai Linh',
      guardians: [
        { fullName: 'Mẹ Linh', relation: 'mother', phone: '0911111111' },
        { fullName: 'Bố Linh', relation: 'father' },
      ],
    });
    const [mom, dad] = s.guardians;
    const r1 = await call(A, 'PATCH', `/students/${s.id}`, {
      school: 'THPT X',
      guardians: [
        {
          id: mom.id,
          fullName: 'Mẹ Linh (đổi)',
          relation: 'mother',
          phone: '0922222222',
        },
        { fullName: 'Ông Ngoại', relation: 'guardian' },
      ],
    });
    expect(r1.statusCode, r1.body).toBe(200);
    const g = r1.json().guardians;
    expect(r1.json().school).toBe('THPT X');
    expect(g.map((x: { fullName: string }) => x.fullName)).toEqual([
      'Mẹ Linh (đổi)',
      'Ông Ngoại',
    ]);
    expect(g[0]).toMatchObject({ id: mom.id, phone: '0922222222' });
    expect(g.map((x: { id: string }) => x.id)).not.toContain(dad.id);
    expect(
      (await guardianRows(s.id)).find((x) => x.id === dad.id)?.removed,
    ).toBe(true);
    // không gửi guardians → không đụng
    const r2 = await call(A, 'PATCH', `/students/${s.id}`, { note: 'ghi chú' });
    expect(r2.json()).toMatchObject({ note: 'ghi chú' });
    expect(r2.json().guardians).toHaveLength(2);
    // mảng rỗng → gỡ hết; tối đa 2 phụ huynh theo schema
    const three = Array.from({ length: 3 }, (_, i) => ({
      fullName: `PH ${i}`,
    }));
    expect(
      (await call(A, 'PATCH', `/students/${s.id}`, { guardians: three }))
        .statusCode,
    ).toBe(422);
    const r3 = await call(A, 'PATCH', `/students/${s.id}`, { guardians: [] });
    expect(r3.json().guardians).toEqual([]);
  });

  it('IDOR guardians[].id: id của học viên khác (cùng tenant), của tenant khác, không tồn tại → 422 cùng một lỗi, dữ liệu không đổi', async () => {
    const mine = await add(A, {
      fullName: 'Em Một',
      guardians: [{ fullName: 'PH Một' }],
    });
    const sameTenant = await add(A, {
      fullName: 'Em Hai',
      guardians: [{ fullName: 'PH Hai', phone: '0933333333' }],
    });
    const foreign = await add(B, {
      fullName: 'Em Ba',
      guardians: [{ fullName: 'PH Ba' }],
    });
    const bodies = [];
    for (const id of [
      sameTenant.guardians[0].id,
      foreign.guardians[0].id,
      randomUUID(),
    ]) {
      const res = await call(A, 'PATCH', `/students/${mine.id}`, {
        guardians: [{ id, fullName: 'BỊ SỬA' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.json().errors)).toEqual(['guardians.0.id']);
      bodies.push(res.json().errors);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    const rows = await t.worker.query(
      `select full_name, phone, student_id from guardians where id = any($1)`,
      [[sameTenant.guardians[0].id, foreign.guardians[0].id]],
    );
    expect(
      rows.rows.map((r) => r.full_name).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['PH Ba', 'PH Hai']);
    expect((await guardianRows(mine.id)).map((x) => x.full_name)).toEqual([
      'PH Một',
    ]);
    // POST: học viên mới chưa có liên kết nào
    const post = await call(A, 'POST', '/students', {
      fullName: 'Em Bốn',
      guardians: [{ id: sameTenant.guardians[0].id, fullName: 'X' }],
    });
    expect(post.statusCode).toBe(422);
    expect(Object.keys(post.json().errors)).toEqual(['guardians.0.id']);
    const n = await t.worker.query(
      `select count(*)::int n from students where full_name = 'Em Bốn'`,
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('tenant B không sửa học viên của A (404) và không thấy trong danh sách/tìm kiếm', async () => {
    const s = await add(A, { fullName: 'Đỗ Quang Huy' });
    const res = await call(B, 'PATCH', `/students/${s.id}`, {
      fullName: 'Hack',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(
      (await call(B, 'GET', '/students?q=quang%20huy')).json().items,
    ).toEqual([]);
    expect(
      (await call(B, 'GET', '/students?pageSize=100'))
        .json()
        .items.map((x: { id: string }) => x.id),
    ).not.toContain(s.id);
    const rows = await t.worker.query(
      `select full_name from students where id = $1`,
      [s.id],
    );
    expect(rows.rows[0].full_name).toBe('Đỗ Quang Huy');
  });

  it('id client trùng id học viên của tenant khác → 409 CONFLICT_STALE; gửi lặp cùng Idempotency-Key → một hồ sơ', async () => {
    const s = await add(A, { fullName: 'Bùi Anh Tuấn' });
    const res = await call(B, 'POST', '/students', {
      id: s.id,
      fullName: 'Khác',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT_STALE');
    const key = randomUUID();
    const body = { fullName: 'Ngô Thu Trang' };
    const r1 = await call(A, 'POST', '/students', body, key);
    const r2 = await call(A, 'POST', '/students', body, key);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json().id).toBe(r1.json().id);
  });
});
