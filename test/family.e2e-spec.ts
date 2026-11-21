import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Teacher = SeededTenant & { token: string };
type Parent = { userId: string; token: string };

const TERMS = '2026-12-01';
const TZ = 'Asia/Ho_Chi_Minh';

// S4-BE-06: /family/**: phụ huynh đọc con qua linked_student_ids(), IDOR, consent guard, chuyên cần theo tuần.
describe('family: phụ huynh xem con', () => {
  let t: TestApp;
  let appPool: pg.Pool;
  let A: Teacher;
  let B: Teacher;
  let seq = 0;

  const call = (
    token: string | null,
    method: 'GET' | 'POST' | 'PATCH',
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
  const mkTeacher = async (name: string): Promise<Teacher> => {
    const s = await seedTenant(t.worker);
    await t.worker.query(`update users set display_name = $2 where id = $1`, [
      s.userId,
      name,
    ]);
    return { ...s, token: await t.tokenFor(s.userId) };
  };
  const mkParent = async (consent = true): Promise<Parent> => {
    const userId = randomUUID();
    await t.worker.query(
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
  /** Học viên + lớp + ghi danh; phụ huynh `p` (nếu có) liên kết qua lời mời thật. */
  const child = async (who: Teacher, p?: Parent, className = 'Toán 9A') => {
    seq++;
    const st = await call(who.token, 'POST', '/students', {
      fullName: 'Lê Gia Bảo',
      dob: `2012-${String(1 + (seq % 12)).padStart(2, '0')}-${String(1 + (seq % 27)).padStart(2, '0')}`,
      notes: 'ghi chú riêng của giáo viên',
      guardians: [
        { fullName: 'Lê Văn A', relation: 'father', phone: '0912345678' },
      ],
    });
    expect(st.statusCode, st.body).toBe(201);
    const s = st.json() as { id: string; guardians: { id: string }[] };
    const cls = await call(who.token, 'POST', '/classes', {
      name: className,
      subject: 'Toán',
      grade: 9,
      mode: 'online',
      startDate: '2026-01-05',
    });
    expect(cls.statusCode, cls.body).toBe(201);
    await call(who.token, 'POST', `/classes/${cls.json().id}/enrollments`, {
      studentId: s.id,
      joinedOn: '2026-01-05',
    });
    if (p) {
      const inv = await call(who.token, 'POST', `/students/${s.id}/invites`, {
        guardianId: s.guardians[0]!.id,
      });
      const acc = await call(p.token, 'POST', '/invites/accept', {
        token: inv.json().token,
      });
      expect(acc.statusCode, acc.body).toBe(200);
    }
    return {
      studentId: s.id,
      guardianId: s.guardians[0]!.id,
      classId: cls.json().id as string,
      who,
    };
  };
  /** Buổi học vào `date` (giờ địa phương) + điểm danh tùy chọn. */
  const session = async (
    c: { classId: string; who: Teacher; studentId: string },
    date: string,
    opts: { status?: string; att?: string; from?: string; to?: string } = {},
  ) => {
    const id = randomUUID();
    await t.worker.query(
      `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
       values ($1, $2, $3, $4, ($4::date + $6::time) at time zone '${TZ}', ($4::date + $7::time) at time zone '${TZ}', $5)`,
      [
        id,
        c.who.tenantId,
        c.classId,
        date,
        opts.status ?? 'planned',
        opts.from ?? '18:00',
        opts.to ?? '19:30',
      ],
    );
    if (opts.att) {
      await t.worker.query(
        `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [c.who.tenantId, id, c.studentId, opts.att],
      );
    }
    return id;
  };
  /** Chạy truy vấn như vai trò teachhub_app với app.user_id = userId (đúng như API). */
  const asUser = async <T>(userId: string, q: string, args: unknown[] = []) => {
    const c = await appPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [userId]);
      const r = await c.query(q, args);
      await c.query('rollback');
      return r.rows as T[];
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

  it('danh sách con gộp mọi giáo viên/tenant của phụ huynh; chỉ cột allowlist (không ghi chú, ngày sinh, liên hệ)', async () => {
    const p = await mkParent();
    const a = await child(A, p, 'Toán 9A');
    const b = await child(B, p, 'Lý 9B');
    const res = await call(p.token, 'GET', '/family/students');
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as {
      id: string;
      fullName: string;
      classes: { id: string; name: string; teacherName: string }[];
    }[];
    expect(items.map((i) => i.id).sort()).toEqual(
      [a.studentId, b.studentId].sort(),
    );
    const ofA = items.find((i) => i.id === a.studentId)!;
    expect(ofA.classes).toEqual([
      { id: a.classId, name: 'Toán 9A', teacherName: 'Cô Lan' },
    ]);
    expect(
      items.find((i) => i.id === b.studentId)!.classes[0]!.teacherName,
    ).toBe('Thầy Bình');
    expect(Object.keys(ofA).sort()).toEqual(['classes', 'fullName', 'id']);
    expect(res.body).not.toMatch(/ghi chú riêng|0912345678|dob|notes|phone/);
  });

  describe('chuyên cần theo tuần', () => {
    it('đếm đúng theo trạng thái; notRecorded chỉ với buổi đã qua giờ kết thúc; buổi hủy không tính; tuần Thứ Hai–Chủ Nhật', async () => {
      const p = await mkParent();
      const c = await child(A, p);
      // Tuần 2026-03-02 (Thứ Hai) → 2026-03-08, toàn bộ ở quá khứ so với giờ hiện tại của test (2026-11).
      await session(c, '2026-03-02', { att: 'present' });
      await session(c, '2026-03-03', { att: 'late' });
      await session(c, '2026-03-04', { att: 'excused' });
      await session(c, '2026-03-05', { att: 'unexcused' });
      await session(c, '2026-03-06'); // quá khứ, chưa điểm danh → notRecorded
      await session(c, '2026-03-07', { status: 'cancelled', att: 'present' }); // hủy: bỏ qua
      await session(c, '2026-03-09', { att: 'present' }); // tuần sau
      const res = await call(
        p.token,
        'GET',
        `/family/students/${c.studentId}/attendance?week=2026-03-04`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const j = res.json();
      expect(j.weekStart).toBe('2026-03-02');
      expect(j.weekEnd).toBe('2026-03-08');
      expect(j.summary).toEqual({
        present: 1,
        late: 1,
        excused: 1,
        unexcused: 1,
        notRecorded: 1,
        upcoming: 0,
      });
      expect(j.sessions).toHaveLength(6);
      const cancelled = j.sessions.find(
        (s: { sessionStatus: string }) => s.sessionStatus === 'cancelled',
      );
      expect(cancelled.attendanceStatus).toBeNull();
      expect(res.body).not.toMatch(/note|reason/i);
      // Tuần kế tiếp thấy buổi 03-09.
      const next = await call(
        p.token,
        'GET',
        `/family/students/${c.studentId}/attendance?week=2026-03-09`,
      );
      expect(next.json().summary.present).toBe(1);
    });

    it('buổi tương lai chưa điểm danh là upcoming, buổi đã qua giờ kết thúc là notRecorded (đếm chính xác)', async () => {
      const p = await mkParent();
      const c = await child(A, p);
      const ymd = (offsetMs: number) =>
        new Date(Date.now() + 7 * 3_600_000 + offsetMs)
          .toISOString()
          .slice(0, 10); // ngày ở UTC+7
      const today = ymd(0);
      const tomorrow = ymd(86_400_000);
      // Buổi hôm nay kết thúc 00:01 (đã qua), buổi ngày mai bắt đầu 00:00 (chưa tới): không phụ thuộc giờ chạy.
      await session(c, today, { from: '00:00', to: '00:01' });
      await session(c, tomorrow, { from: '00:00', to: '00:01' });
      // Nếu hôm nay là Chủ Nhật thì ngày mai rơi sang tuần sau: mỗi tuần được kiểm riêng.
      const weekOf = async (d: string) =>
        (
          await call(
            p.token,
            'GET',
            `/family/students/${c.studentId}/attendance?week=${d}`,
          )
        ).json();
      const wToday = await weekOf(today);
      const wTomorrow = await weekOf(tomorrow);
      const same = wToday.weekStart === wTomorrow.weekStart;
      expect(wToday.summary).toMatchObject({
        notRecorded: 1,
        upcoming: same ? 1 : 0,
      });
      expect(wTomorrow.summary).toMatchObject({
        upcoming: 1,
        notRecorded: same ? 1 : 0,
      });
    });

    it('week sai định dạng → 422', async () => {
      const p = await mkParent();
      const c = await child(A, p);
      const res = await call(
        p.token,
        'GET',
        `/family/students/${c.studentId}/attendance?week=abc`,
      );
      expect(res.statusCode).toBe(422);
    });
  });

  describe('IDOR và quyền', () => {
    it('cross-parent / cross-tenant / học viên không tồn tại: cùng 404, cùng thân', async () => {
      const x = await mkParent();
      const y = await mkParent();
      const cx = await child(A, x);
      const cy = await child(A, y);
      const cb = await child(B, y, 'Lý 9B'); // Y còn con ở tenant khác; X không liên quan
      const urls = [cy.studentId, cb.studentId, randomUUID()].map(
        (id) => `/family/students/${id}/attendance`,
      );
      const bodies = new Set<string>();
      for (const u of urls) {
        const r = await call(x.token, 'GET', u);
        expect(r.statusCode, u).toBe(404);
        const { requestId: _r, ...rest } = r.json();
        bodies.add(JSON.stringify(rest));
      }
      expect(bodies.size).toBe(1);
      // Con mình vẫn đọc được.
      expect(
        (
          await call(
            x.token,
            'GET',
            `/family/students/${cx.studentId}/attendance`,
          )
        ).statusCode,
      ).toBe(200);
      // Danh sách của X không chứa con của Y.
      const list = (await call(x.token, 'GET', '/family/students')).json()
        .items as { id: string }[];
      expect(list.map((i) => i.id)).toEqual([cx.studentId]);
    });

    it('RLS: user X truy vấn trực tiếp bằng role app: 0 dòng ở bảng gốc, hàm family chỉ trả con của X', async () => {
      const x = await mkParent();
      const y = await mkParent();
      const cx = await child(A, x);
      const cy = await child(B, y, 'Lý 9B');
      await session(cy, '2026-03-02', { att: 'present' });
      for (const tbl of [
        'students',
        'guardians',
        'attendance',
        'sessions',
        'enrollments',
        'classes',
        'invites',
      ]) {
        const rows = await asUser(x.userId, `select 1 from ${tbl}`);
        expect(rows, tbl).toHaveLength(0);
      }
      const fam = await asUser<{ student_id: string }>(
        x.userId,
        `select * from app_private.family_students()`,
      );
      expect(new Set(fam.map((r) => r.student_id))).toEqual(
        new Set([cx.studentId]),
      );
      const tz = await asUser(
        x.userId,
        `select * from app_private.family_student_timezone($1)`,
        [cy.studentId],
      );
      expect(tz).toHaveLength(0);
      const wk = await asUser(
        x.userId,
        `select * from app_private.family_week_sessions($1, '2026-03-01', '2026-03-31')`,
        [cy.studentId],
      );
      expect(wk).toHaveLength(0);
      // Không có user (app.user_id rỗng) cũng 0 dòng.
      expect(
        await asUser(
          '00000000-0000-0000-0000-000000000000',
          `select * from app_private.family_students()`,
        ),
      ).toHaveLength(0);
    });

    it('sau khi giáo viên gỡ phụ huynh khỏi học viên: 404 qua API, 0 dòng qua hàm; con khác vẫn đọc được', async () => {
      const p = await mkParent();
      const c1 = await child(A, p);
      const c2 = await child(A, p, 'Văn 9C');
      expect(
        (
          await call(
            p.token,
            'GET',
            `/family/students/${c1.studentId}/attendance`,
          )
        ).statusCode,
      ).toBe(200);
      const rm = await call(A.token, 'PATCH', `/students/${c1.studentId}`, {
        guardians: [],
      });
      expect(rm.statusCode, rm.body).toBe(200);
      expect(
        (
          await call(
            p.token,
            'GET',
            `/family/students/${c1.studentId}/attendance`,
          )
        ).statusCode,
      ).toBe(404);
      const fam = await asUser<{ student_id: string }>(
        p.userId,
        `select * from app_private.family_students()`,
      );
      expect(new Set(fam.map((r) => r.student_id))).toEqual(
        new Set([c2.studentId]),
      );
      expect(
        (await call(p.token, 'GET', '/family/students'))
          .json()
          .items.map((i: { id: string }) => i.id),
      ).toEqual([c2.studentId]);
    });

    it('giáo viên (không có vai trò parent) 403; chưa đăng nhập 401', async () => {
      const c = await child(A);
      expect((await call(A.token, 'GET', '/family/students')).statusCode).toBe(
        403,
      );
      expect(
        (
          await call(
            A.token,
            'GET',
            `/family/students/${c.studentId}/attendance`,
          )
        ).statusCode,
      ).toBe(403);
      expect((await call(null, 'GET', '/family/students')).statusCode).toBe(
        401,
      );
    });

    it('học sinh (membership student) gọi /family/* → 403', async () => {
      const c = await child(A);
      const userId = randomUUID();
      await t.worker.query(
        `insert into users (id, email, display_name) values ($1, $2, 'HS')`,
        [userId, `${userId}@example.com`],
      );
      await t.worker.query(
        `insert into memberships (id, user_id, role, student_id) values ($1, $2, 'student', $3)`,
        [randomUUID(), userId, c.studentId],
      );
      const token = await t.tokenFor(userId);
      for (const url of [
        '/family/students',
        `/family/students/${c.studentId}/attendance`,
      ]) {
        expect((await call(token, 'GET', url)).statusCode, url).toBe(403);
      }
    });

    it('chưa đồng ý điều khoản → 403 CONSENT_REQUIRED kèm termsVersion, trước cả khi tra dữ liệu', async () => {
      const p = await mkParent(false);
      const c = await child(A, await mkParent(), 'Toán 9A');
      // p chưa đồng ý nên không nhận được lời mời; tạo membership parent trực tiếp để chạm tới guard consent.
      const role = await call(p.token, 'POST', '/me/roles', { role: 'parent' });
      expect(role.statusCode, role.body).toBe(201);
      for (const u of [
        '/family/students',
        `/family/students/${c.studentId}/attendance`,
        `/family/students/${randomUUID()}/attendance`,
      ]) {
        const r = await call(p.token, 'GET', u);
        expect(r.statusCode, u).toBe(403);
        expect(r.json()).toMatchObject({
          code: 'CONSENT_REQUIRED',
          details: { termsVersion: TERMS },
        });
      }
    });
  });
});
