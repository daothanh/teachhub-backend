import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

// S2-BE-06 (ghi danh) và S2-BE-06b (roster): US-1.4 AC3.
describe('enrollments + roster API', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;

  const call = (
    who: Who,
    method: 'GET' | 'POST',
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
  const newClass = async (who: Who, name = 'Toán 9A') => {
    const res = await call(who, 'POST', '/classes', {
      name,
      subject: 'Toán',
      grade: 9,
      mode: 'online',
      startDate: '2026-12-14',
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const newStudent = async (who: Who, fullName: string) => {
    const res = await call(who, 'POST', '/students', { fullName });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const enroll = (who: Who, classId: string, studentId: string, extra = {}) =>
    call(who, 'POST', `/classes/${classId}/enrollments`, {
      studentId,
      ...extra,
    });
  const count = async (sql: string, params: unknown[]) =>
    (await t.worker.query(sql, params)).rows[0].n as number;

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
  }, 180_000);
  afterAll(() => t?.stop());

  it('AC3: một học viên ở 2 lớp → 1 dòng students, 2 dòng enrollments; ghi danh lại cùng lớp → 200 trả bản cũ', async () => {
    const [c1, c2] = [await newClass(A, 'Toán'), await newClass(A, 'Lý')];
    const s = await newStudent(A, 'Nguyễn Minh Anh');
    const r1 = await enroll(A, c1, s, { joinedOn: '2026-12-14' });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({
      classId: c1,
      studentId: s,
      joinedOn: '2026-12-14',
    });
    const r2 = await enroll(A, c2, s);
    expect(r2.statusCode).toBe(201);
    const again = await enroll(A, c1, s, { joinedOn: '2027-01-01' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(r1.json());
    expect(
      await count(
        `select count(*)::int n from students where tenant_id = $1 and full_name = 'Nguyễn Minh Anh'`,
        [A.tenantId],
      ),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::int n from enrollments where student_id = $1`,
        [s],
      ),
    ).toBe(2);
  });

  it('joinedOn mặc định là hôm nay theo múi giờ tenant', async () => {
    const c = await newClass(A);
    const s = await newStudent(A, 'Lê Thị Hoa');
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(new Date());
    expect((await enroll(A, c, s)).json().joinedOn).toBe(today);
  });

  it('lớp đã lưu trữ hoặc học viên đã nghỉ → 409 CONFLICT_STALE, không ghi gì', async () => {
    const archived = await newClass(A, 'Cũ');
    const live = await newClass(A, 'Mới');
    const s = await newStudent(A, 'Trần Gia Bảo');
    const gone = await newStudent(A, 'Đã Nghỉ Học');
    await call(A, 'POST', `/classes/${archived}/archive`);
    await t.worker.query(`update students set status = 'left' where id = $1`, [
      gone,
    ]);
    const r1 = await enroll(A, archived, s);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().code).toBe('CONFLICT_STALE');
    const r2 = await enroll(A, live, gone);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe('CONFLICT_STALE');
    expect(
      await count(
        `select count(*)::int n from enrollments where class_id = any($1) and student_id = any($2)`,
        [
          [archived, live],
          [s, gone],
        ],
      ),
    ).toBe(0);
  });

  it('studentId của tenant khác trả cùng mã và nội dung với studentId không tồn tại; không ghi danh chéo tenant', async () => {
    const cA = await newClass(A);
    const foreign = await newStudent(B, 'Học viên của B');
    const r1 = await enroll(A, cA, foreign);
    const r2 = await enroll(A, cA, randomUUID());
    expect([r1.statusCode, r2.statusCode]).toEqual([404, 404]);
    expect(r1.json().code).toBe('NOT_FOUND');
    expect({ ...r1.json(), requestId: 0 }).toEqual({
      ...r2.json(),
      requestId: 0,
    });
    // B ghi danh học viên của B vào lớp của A, đọc roster lớp A → 404
    const own = await newStudent(B, 'Học viên B hai');
    expect((await enroll(B, cA, own)).statusCode).toBe(404);
    expect((await call(B, 'GET', `/classes/${cA}/roster`)).statusCode).toBe(
      404,
    );
    expect(
      await count(
        `select count(*)::int n from enrollments where tenant_id = $1`,
        [B.tenantId],
      ),
    ).toBe(0);
  });

  it('roster: chỉ ghi danh chưa rời lớp, kèm studentStatus; enrolledCount và lọc students?classId khớp', async () => {
    const c = await newClass(A, 'Roster');
    const [s1, s2, s3, s4] = [
      await newStudent(A, 'Anh Một'),
      await newStudent(A, 'Bình Hai'),
      await newStudent(A, 'Chi Ba'),
      await newStudent(A, 'Dung Bốn'),
    ];
    for (const s of [s1, s2, s3, s4])
      await enroll(A, c, s, { joinedOn: '2026-12-14' });
    await t.worker.query(
      `update students set status = 'paused' where id = $1`,
      [s2],
    );
    await t.worker.query(
      `update enrollments set left_on = '2026-12-20' where student_id = $1`,
      [s3],
    );
    await t.worker.query(`update students set status = 'left' where id = $1`, [
      s4,
    ]);

    const roster = (await call(A, 'GET', `/classes/${c}/roster`)).json();
    expect(
      roster.items.map(
        (i: { studentId: string; studentStatus: string; joinedOn: string }) => [
          i.studentId,
          i.studentStatus,
          i.joinedOn,
        ],
      ),
    ).toEqual([
      [s1, 'active', '2026-12-14'],
      [s2, 'paused', '2026-12-14'],
    ]);
    expect(roster.items[0]).toHaveProperty('enrollmentId');
    expect((await call(A, 'GET', `/classes/${c}`)).json().enrolledCount).toBe(
      2,
    );
    const inClass = (
      await call(A, 'GET', `/students?classId=${c}&status=paused`)
    ).json();
    expect(inClass.items.map((x: { id: string }) => x.id)).toEqual([s2]);
  });

  it('gửi lặp cùng Idempotency-Key → phát lại 201, một ghi danh', async () => {
    const s = await newStudent(A, 'Phạm Thu Hà');
    const key = randomUUID();
    const c2 = await newClass(A);
    const a = await call(
      A,
      'POST',
      `/classes/${c2}/enrollments`,
      { studentId: s },
      key,
    );
    const b = await call(
      A,
      'POST',
      `/classes/${c2}/enrollments`,
      { studentId: s },
      key,
    );
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(
      await count(
        `select count(*)::int n from enrollments where class_id = $1`,
        [c2],
      ),
    ).toBe(1);
  });

  it('classId của tenant khác: ghi danh và roster đều 404, không ghi gì', async () => {
    const cA = await newClass(A, 'Của A');
    const sB = await newStudent(B, 'Học viên B');
    const res = await enroll(B, cA, sB);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect((await call(B, 'GET', `/classes/${cA}/roster`)).statusCode).toBe(
      404,
    );
    expect(
      await count(
        `select count(*)::int n from enrollments where class_id = $1`,
        [cA],
      ),
    ).toBe(0);
  });

  it('hai ghi danh song song cùng học viên + lớp: một 201, một 200 cùng bản ghi', async () => {
    const c = await newClass(A, 'Song song');
    const s = await newStudent(A, 'Lê Song Song');
    const [r1, r2] = await Promise.all([enroll(A, c, s), enroll(A, c, s)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
    expect(r1.json().id).toBe(r2.json().id);
    expect(
      await count(
        `select count(*)::int n from enrollments where class_id = $1`,
        [c],
      ),
    ).toBe(1);
  });

  it('user không phải tenant_owner → 403 ở ghi danh và roster', async () => {
    const teacher = await seedMember(t.worker, A.tenantId, 'teacher');
    const w = { ...A, token: await t.tokenFor(teacher) };
    const c = await newClass(A, 'Cấm');
    const s = await newStudent(A, 'Nguyễn Cấm');
    expect((await enroll(w, c, s)).statusCode).toBe(403);
    expect((await call(w, 'GET', `/classes/${c}/roster`)).statusCode).toBe(403);
  });
});
