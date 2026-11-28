import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { startTestApp, type TestApp } from './support/app.js';
import {
  familyFixture,
  type Parent,
  type Teacher,
} from './support/family-fixture.js';

const TZ = 'Asia/Ho_Chi_Minh';

interface Report {
  id: string;
  sessionId: string;
  studentId: string;
  className: string;
  reason: string;
  note: string | null;
  sessionStartsAt: string;
  reportedAt: string;
}
interface Item {
  studentId: string;
  status: string | null;
  recordedByName: string | null;
  parentReport: { reason: string; note: string | null } | null;
}

// US-3.4 (phụ huynh báo vắng trước), US-3.1 AC5 (parentReport), US-3.2 AC2, US-3.3 (recordedByName).
describe('phụ huynh báo vắng trước', () => {
  let t: TestApp;
  let f: ReturnType<typeof familyFixture>;
  let A: Teacher;
  let B: Teacher;
  let P1: Parent;
  let P2: Parent; // người giám hộ thứ hai của cùng con
  let X: Parent; // phụ huynh khác, không liên kết
  let appPool: pg.Pool;

  const req = (
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    key: string | null = method === 'POST' || method === 'PUT'
      ? randomUUID()
      : null,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });

  /** Con của `who` (liên kết với `p`) ghi danh một lớp mới. */
  const kid = async (who: Teacher, p: Parent) => {
    const c = await f.child(who, p);
    const classId = randomUUID();
    await f.q(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
       values ($1, $2, $3, 'Toán 9A', 'Toán', 9, 'online', current_date - 60)`,
      [classId, who.tenantId, who.branchId],
    );
    await f.q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, current_date - 30)`,
      [randomUUID(), who.tenantId, classId, c.studentId],
    );
    return { ...c, classId };
  };
  /** Người giám hộ thứ hai `p` của con `studentId` (nối thẳng DB, kèm vai trò parent). */
  const link = async (tenantId: string, studentId: string, p: Parent) => {
    await f.q(
      `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'PH hai', $4)`,
      [randomUUID(), tenantId, studentId, p.userId],
    );
    await f.q(
      `insert into memberships (id, user_id, role) select $1, $2, 'parent'
        where not exists (select 1 from memberships where user_id = $2 and role = 'parent')`,
      [randomUUID(), p.userId],
    );
  };
  /** Buổi bắt đầu sau `hours` giờ (âm = đã qua). */
  const session = async (
    who: Teacher,
    classId: string,
    hours: number,
    status = 'planned',
  ) => {
    const id = randomUUID();
    await f.q(
      `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
       values ($1, $2, $3, ((now() + make_interval(hours => $4::int)) at time zone '${TZ}')::date,
               now() + make_interval(hours => $4::int), now() + make_interval(hours => $4::int + 1), $5)`,
      [id, who.tenantId, classId, hours, status],
    );
    return id;
  };
  const report = (
    p: Parent,
    sessionId: string,
    studentId: string,
    over: object = {},
    key?: string,
  ) =>
    req(
      p.token,
      'POST',
      '/family/absence-requests',
      { sessionId, studentId, reason: 'sick', note: 'Con sốt', ...over },
      key ?? randomUUID(),
    );
  const items = async (who: Teacher, sessionId: string) =>
    (
      (
        await req(who.token, 'GET', `/sessions/${sessionId}/attendance`)
      ).json() as {
        items: Item[];
      }
    ).items;
  const outbox = async (who: Teacher, id?: string) =>
    (
      await f.q(
        `select type, payload from outbox_events where tenant_id = $1 and type = 'student_absence_reported'
           and ($2::text is null or payload->>'absenceRequestId' = $2) order by created_at`,
        [who.tenantId, id ?? null],
      )
    ).length;
  /** Chạy như vai trò teachhub_app với app.user_id (đúng như API). */
  const asApp = async (userId: string, q: string, args: unknown[] = []) => {
    const c = await appPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [userId]);
      const r = await c.query(q, args);
      return r.rows as Record<string, unknown>[];
    } finally {
      // Luôn rollback (kể cả khi câu lệnh lỗi) để connection trả về pool không kẹt trong transaction đã abort.
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };

  /** Notifier thật trên DB thật, chỉ giả phần gửi push; `deliver` đếm số lần gửi. */
  const mkNotifier = async () => {
    const { AbsenceReportedNotifier } =
      await import('../libs/modules/notifications/application/absence-reported-notifier.service.js');
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const deliver = vi.fn().mockResolvedValue(true);
    const notifier = new AbsenceReportedNotifier(
      new TxService(drizzle(t.worker, { schema, casing: 'snake_case' })),
      { deliver } as never,
    );
    const run = (absenceRequestId: string) =>
      notifier.handle({
        eventId: randomUUID(),
        tenantId: A.tenantId,
        payload: { absenceRequestId },
      });
    return { deliver, run };
  };

  beforeAll(async () => {
    t = await startTestApp();
    f = familyFixture(t);
    appPool = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    A = await f.mkTeacher('Cô Lan');
    B = await f.mkTeacher('Thầy Nam');
    P1 = await f.mkParent();
    P2 = await f.mkParent();
    X = await f.mkParent();
    // X là phụ huynh thật (có vai trò parent) nhưng không liên kết con của ai trong các ca đầu: kiểm nhánh 404, không phải guard 403.
    await f.q(
      `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
      [randomUUID(), X.userId],
    );
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await t?.stop();
  });

  it('tạo báo vắng: 201, điểm danh trả parentReport, outbox một sự kiện (US-3.4 AC1, US-3.1 AC5)', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const res = await report(P1, s, c.studentId, {
      reason: 'family',
      note: 'Đi giỗ',
    });
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json() as Report;
    expect(r).toMatchObject({
      sessionId: s,
      studentId: c.studentId,
      className: 'Toán 9A',
      reason: 'family',
      note: 'Đi giỗ',
    });
    expect(r.sessionStartsAt).toMatch(/\+07:00$/);
    expect(await outbox(A, r.id)).toBe(1);

    const it = (await items(A, s)).find((i) => i.studentId === c.studentId)!;
    expect(it.status).toBeNull();
    expect(it.parentReport).toMatchObject({ reason: 'family', note: 'Đi giỗ' });
  });

  it('trùng: 200 trả bản đang có (kể cả người giám hộ khác báo), không outbox thêm; replay cùng key trả cùng phản hồi', async () => {
    const c = await kid(A, P1);
    await link(A.tenantId, c.studentId, P2);
    const s = await session(A, c.classId, 30);
    const key = randomUUID();
    const first = await report(P1, s, c.studentId, {}, key);
    expect(first.statusCode, first.body).toBe(201);
    const id = (first.json() as Report).id;
    const replay = await report(P1, s, c.studentId, {}, key);
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as Report).id).toBe(id);
    const again = await report(P2, s, c.studentId, {
      reason: 'other',
      note: undefined,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ id, reason: 'sick', note: 'Con sốt' });
    expect(await outbox(A, id)).toBe(1);
    expect(
      (
        await f.q(
          `select count(*)::int as n from absence_requests where session_id = $1 and student_id = $2 and cancelled_at is null`,
          [s, c.studentId],
        )
      )[0].n,
    ).toBe(1);
  });

  it('buổi đã bắt đầu → 409 ABSENCE_SESSION_STARTED; buổi hủy → 409 SESSION_CANCELLED (US-3.4 AC2)', async () => {
    const c = await kid(A, P1);
    const past = await session(A, c.classId, -1);
    const started = await report(P1, past, c.studentId);
    expect(started.statusCode).toBe(409);
    expect(started.json().code).toBe('ABSENCE_SESSION_STARTED');
    const cancelled = await session(A, c.classId, 48, 'cancelled');
    const res = await report(P1, cancelled, c.studentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SESSION_CANCELLED');
    expect(
      (
        await f.q(
          `select count(*)::int as n from absence_requests where student_id = $1`,
          [c.studentId],
        )
      )[0].n,
    ).toBe(0);
  });

  it('phân quyền: phụ huynh không liên kết, tenant khác, con không thuộc lớp → 404; thiếu consent → 403; giáo viên → 403; body sai → 422', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    // phụ huynh có consent nhưng không liên kết con này
    expect((await report(X, s, c.studentId)).statusCode).toBe(404);
    // phụ huynh của tenant khác báo con của A cho buổi của A
    const cb = await kid(B, X);
    expect((await report(X, s, cb.studentId)).statusCode).toBe(404);
    // con của mình nhưng buổi của tenant khác
    const sb = await session(B, cb.classId, 24);
    expect((await report(P1, sb, c.studentId)).statusCode).toBe(404);
    // con của mình nhưng buổi của lớp khác (không ghi danh)
    const other = await kid(A, P2);
    const sOther = await session(A, other.classId, 24);
    expect((await report(P1, sOther, c.studentId)).statusCode).toBe(404);
    // buổi không tồn tại
    expect((await report(P1, randomUUID(), c.studentId)).statusCode).toBe(404);
    // chưa đồng ý điều khoản
    const noConsent = await f.mkParent(false);
    const nc = await report(noConsent, s, c.studentId);
    expect(nc.statusCode).toBe(403);
    // giáo viên không có vai trò parent
    expect(
      (await report(A as unknown as Parent, s, c.studentId)).statusCode,
    ).toBe(403);
    // body sai
    expect(
      (await report(P1, s, c.studentId, { reason: 'bored' })).statusCode,
    ).toBe(422);
    expect(
      (await report(P1, s, c.studentId, { note: 'x'.repeat(301) })).statusCode,
    ).toBe(422);
    expect(
      (
        await f.q(
          `select count(*)::int as n from absence_requests where student_id = $1`,
          [c.studentId],
        )
      )[0].n,
    ).toBe(0);
  });

  it('GET: chỉ báo vắng hiệu lực của buổi chưa bắt đầu, người giám hộ nào cũng thấy; không liên kết → 404', async () => {
    const c = await kid(A, P1);
    await link(A.tenantId, c.studentId, P2);
    const s1 = await session(A, c.classId, 24);
    const s2 = await session(A, c.classId, 72);
    const s3 = await session(A, c.classId, 96);
    const r1 = (await report(P1, s1, c.studentId)).json() as Report;
    const r2 = (await report(P1, s2, c.studentId)).json() as Report;
    const r3 = (await report(P1, s3, c.studentId)).json() as Report;
    await req(P1.token, 'DELETE', `/family/absence-requests/${r3.id}`);
    // r1 đã bắt đầu sau khi báo
    await f.q(
      `update sessions set starts_at = now() - interval '1 hour' where id = $1`,
      [s1],
    );
    const res = await req(
      P1.token,
      'GET',
      `/family/absence-requests?studentId=${c.studentId}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: Report[] }).items.map((x) => x.id)).toEqual([
      r2.id,
    ]);
    const viaP2 = await req(
      P2.token,
      'GET',
      `/family/absence-requests?studentId=${c.studentId}`,
    );
    expect(
      (viaP2.json() as { items: Report[] }).items.map((x) => x.id),
    ).toEqual([r2.id]);
    expect(r1.id).not.toBe(r2.id);
    const denied = await req(
      X.token,
      'GET',
      `/family/absence-requests?studentId=${c.studentId}`,
    );
    expect(denied.statusCode).toBe(404);
    expect(
      (await req(P1.token, 'GET', '/family/absence-requests')).statusCode,
    ).toBe(422);
  });

  it('hủy: người giám hộ liên kết hủy được, idempotent, điểm danh hết parentReport, báo lại hồi sinh đúng dòng cũ (US-3.4 AC3)', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const r = (await report(P1, s, c.studentId)).json() as Report;
    // không liên kết → 404, báo vắng vẫn còn
    expect(
      (await req(X.token, 'DELETE', `/family/absence-requests/${r.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await items(A, s)).find((i) => i.studentId === c.studentId)!
        .parentReport,
    ).not.toBeNull();
    const del = await req(
      P1.token,
      'DELETE',
      `/family/absence-requests/${r.id}`,
    );
    expect(del.statusCode, del.body).toBe(204);
    expect(
      (await req(P1.token, 'DELETE', `/family/absence-requests/${r.id}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await items(A, s)).find((i) => i.studentId === c.studentId)!
        .parentReport,
    ).toBeNull();
    // người giám hộ thứ hai của cùng con báo lại → hồi sinh đúng dòng cũ
    await link(A.tenantId, c.studentId, P2);
    const again = await report(P2, s, c.studentId, {
      reason: 'other',
      note: undefined,
    });
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json() as Report).id).toBe(r.id);
    expect(
      (
        await f.q(
          `select count(*)::int as n from absence_requests where student_id = $1`,
          [c.studentId],
        )
      )[0].n,
    ).toBe(1);
  });

  it('hủy sau giờ bắt đầu → 409 ABSENCE_SESSION_STARTED, báo vắng giữ nguyên; id lạ → 404', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const r = (await report(P1, s, c.studentId)).json() as Report;
    await f.q(
      `update sessions set starts_at = now() - interval '1 minute' where id = $1`,
      [s],
    );
    const res = await req(
      P1.token,
      'DELETE',
      `/family/absence-requests/${r.id}`,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ABSENCE_SESSION_STARTED');
    expect(
      (
        await f.q(`select cancelled_at from absence_requests where id = $1`, [
          r.id,
        ])
      )[0].cancelled_at,
    ).toBeNull();
    expect(
      (
        await req(
          P1.token,
          'DELETE',
          `/family/absence-requests/${randomUUID()}`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('điểm danh: recordedByName là tên người ghi bản đang lưu, null khi chưa có dòng (US-3.3)', async () => {
    const c = await kid(A, P1);
    const c2 = await f.child(A, P2);
    await f.q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, current_date - 30)`,
      [randomUUID(), A.tenantId, c.classId, c2.studentId],
    );
    const s = await session(A, c.classId, -1);
    const sync = await req(A.token, 'POST', '/attendance/sync', {
      deviceId: randomUUID(),
      deviceTime: new Date().toISOString(),
      sessionId: s,
      markSessionTaught: false,
      mutations: [
        {
          clientMutationId: randomUUID(),
          studentId: c.studentId,
          status: 'present',
          note: null,
          clientUpdatedAt: new Date().toISOString(),
        },
      ],
    });
    expect(sync.statusCode, sync.body).toBe(200);
    const list = await items(A, s);
    expect(list.find((i) => i.studentId === c.studentId)!.recordedByName).toBe(
      'Cô Lan',
    );
    expect(
      list.find((i) => i.studentId === c2.studentId)!.recordedByName,
    ).toBeNull();
  });

  it('sync: có parentReport và đánh vắng có phép → không báo lại phụ huynh; vắng không phép của con khác vẫn báo (US-3.2 AC2)', async () => {
    const c = await kid(A, P1);
    const c2 = await f.child(A, P2);
    await f.q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, current_date - 30)`,
      [randomUUID(), A.tenantId, c.classId, c2.studentId],
    );
    const s = await session(A, c.classId, 2);
    expect((await report(P1, s, c.studentId)).statusCode).toBe(201);
    // buổi bắt đầu rồi giáo viên điểm danh (ngày buổi học = hôm nay theo giờ VN)
    await f.q(
      `update sessions set starts_at = now() - interval '1 hour', session_date = (now() at time zone '${TZ}')::date where id = $1`,
      [s],
    );
    const m = (studentId: string, status: string) => ({
      clientMutationId: randomUUID(),
      studentId,
      status,
      note: null,
      clientUpdatedAt: new Date().toISOString(),
    });
    const sync = await req(A.token, 'POST', '/attendance/sync', {
      deviceId: randomUUID(),
      deviceTime: new Date().toISOString(),
      sessionId: s,
      markSessionTaught: true,
      mutations: [m(c.studentId, 'excused'), m(c2.studentId, 'unexcused')],
    });
    expect(sync.statusCode, sync.body).toBe(200);
    // chỉ phụ huynh của con vắng không phép được báo
    expect(sync.json().parentsToNotify).toBe(1);
    expect(sync.json().summary).toMatchObject({ excused: 1, unexcused: 1 });
    const ev = (
      await f.q(
        `select payload from outbox_events where tenant_id = $1 and type = 'attendance_recorded' and payload->>'sessionId' = $2`,
        [A.tenantId, s],
      )
    )[0].payload as { changes: { studentId: string; status: string }[] };
    expect(ev.changes.find((x) => x.studentId === c.studentId)?.status).toBe(
      'excused',
    );
  });

  it('RLS: phụ huynh chỉ đọc báo vắng của con liên kết, không ghi trực tiếp; tenant khác không thấy', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const r = (await report(P1, s, c.studentId)).json() as Report;
    const sel = `select id from absence_requests where id = $1`;
    expect(await asApp(P1.userId, sel, [r.id])).toHaveLength(1);
    expect(await asApp(A.userId, sel, [r.id])).toHaveLength(1); // nhân sự tenant
    expect(await asApp(X.userId, sel, [r.id])).toHaveLength(0); // phụ huynh không liên kết
    expect(await asApp(B.userId, sel, [r.id])).toHaveLength(0); // giáo viên tenant khác
    await expect(
      asApp(
        P1.userId,
        `insert into absence_requests (id, tenant_id, session_id, student_id, reported_by_user_id, reason)
         values (gen_random_uuid(), $1, $2, $3, $4, 'sick')`,
        [A.tenantId, randomUUID(), c.studentId, P1.userId],
      ),
    ).rejects.toThrow();
    expect(
      await asApp(
        P1.userId,
        `update absence_requests set cancelled_at = now() where id = $1 returning id`,
        [r.id],
      ),
    ).toHaveLength(0);
    const gone = await f.q(
      `select cancelled_at from absence_requests where id = $1`,
      [r.id],
    );
    expect(gone[0].cancelled_at).toBeNull();
  });

  it('báo → hủy → báo lại 5 lần: một dòng, tối đa một outbox (chống spam giáo viên)', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const n = await mkNotifier();
    let id = '';
    for (let i = 0; i < 5; i++) {
      const res = await report(P1, s, c.studentId, { note: `lần ${i}` });
      expect(res.statusCode, res.body).toBe(201);
      id ||= (res.json() as Report).id;
      // Worker xử lý sự kiện đầu khi dòng còn hiệu lực: từ đó giáo viên đã có thông báo cho (buổi, con).
      if (i === 0) await n.run(id);
      expect((res.json() as Report).id).toBe(id);
      expect(
        (await req(P1.token, 'DELETE', `/family/absence-requests/${id}`))
          .statusCode,
      ).toBe(204);
    }
    expect(
      (
        await f.q(
          `select count(*)::int as n from absence_requests where student_id = $1`,
          [c.studentId],
        )
      )[0].n,
    ).toBe(1);
    expect(await outbox(A, id)).toBe(1);
    // hủy đã quá 10 phút thì báo lại được thông báo lại
    await f.q(
      `update absence_requests set cancelled_at = now() - interval '11 minutes', created_at = now() - interval '12 minutes' where id = $1`,
      [id],
    );
    expect((await report(P1, s, c.studentId, { note: 'lại' })).statusCode).toBe(
      201,
    );
    expect(await outbox(A, id)).toBe(2);
  });

  it('hai người giám hộ báo đồng thời → đúng một báo vắng và một outbox', async () => {
    const c = await kid(A, P1);
    await link(A.tenantId, c.studentId, P2);
    const s = await session(A, c.classId, 24);
    const [a, b] = await Promise.all([
      report(P1, s, c.studentId),
      report(P2, s, c.studentId),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect((a.json() as Report).id).toBe((b.json() as Report).id);
    expect(await outbox(A, (a.json() as Report).id)).toBe(1);
  });

  it('ghi danh: rời đúng ngày buổi hoặc học viên đã nghỉ học → 404', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    await f.q(
      `update enrollments set left_on = (select session_date from sessions where id = $1) where student_id = $2`,
      [s, c.studentId],
    );
    expect((await report(P1, s, c.studentId)).statusCode).toBe(404);
    await f.q(`update enrollments set left_on = null where student_id = $1`, [
      c.studentId,
    ]);
    expect((await report(P1, s, c.studentId)).statusCode).toBe(201);
    const c2 = await kid(A, P1);
    const s2 = await session(A, c2.classId, 24);
    await f.q(`update students set status = 'left' where id = $1`, [
      c2.studentId,
    ]);
    expect((await report(P1, s2, c2.studentId)).statusCode).toBe(404);
  });

  it('đổi lịch lặp xóa buổi tương lai có báo vắng → 200, báo vắng mất theo (FK cascade)', async () => {
    const c = await f.child(A, P1);
    const cls = await req(A.token, 'POST', '/classes', {
      name: 'Lý 9B',
      subject: 'Lý',
      grade: 9,
      mode: 'online',
      startDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      endDate: new Date(Date.now() + 20 * 86_400_000)
        .toISOString()
        .slice(0, 10),
    });
    expect(cls.statusCode, cls.body).toBe(201);
    const classId = (cls.json() as { id: string }).id;
    await f.q(
      `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, current_date - 1)`,
      [randomUUID(), A.tenantId, classId, c.studentId],
    );
    const rules = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      startTime: '18:00',
      durationMin: 90,
    }));
    const put = (r: object[]) =>
      req(
        A.token,
        'PUT',
        `/classes/${classId}/schedule-rules`,
        { rules: r },
        randomUUID(),
      );
    expect((await put(rules)).statusCode).toBe(200);
    const [row] = await f.q(
      `select id from sessions where class_id = $1 and status = 'planned' and starts_at > now() + interval '2 hours' order by starts_at limit 1`,
      [classId],
    );
    const r = await report(P1, row.id as string, c.studentId);
    expect(r.statusCode, r.body).toBe(201);
    const res = await put([]);
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (
        await f.q(
          `select count(*)::int as n from absence_requests where student_id = $1`,
          [c.studentId],
        )
      )[0].n,
    ).toBe(0);
  });

  it('báo rồi hủy ngay (worker bỏ qua sự kiện đầu) → báo lại trong 10 phút vẫn ghi outbox để giáo viên biết', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const n = await mkNotifier();
    const id = ((await report(P1, s, c.studentId)).json() as Report).id;
    await req(P1.token, 'DELETE', `/family/absence-requests/${id}`);
    await n.run(id); // dòng đang hủy: không thông báo
    expect(
      await f.q(
        `select 1 from notifications where payload->>'absenceRequestId' = $1`,
        [id],
      ),
    ).toHaveLength(0);
    expect((await report(P1, s, c.studentId)).statusCode).toBe(201);
    expect(await outbox(A, id)).toBe(2);
    await n.run(id);
    expect(
      await f.q(
        `select 1 from notifications where payload->>'absenceRequestId' = $1`,
        [id],
      ),
    ).toHaveLength(1);
    expect(n.deliver).toHaveBeenCalledTimes(1);
  });

  it('push không lặp: thông báo đã gửi push xong thì sự kiện sau không gửi lại', async () => {
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const n = await mkNotifier();
    const id = ((await report(P1, s, c.studentId)).json() as Report).id;
    await n.run(id);
    expect(n.deliver).toHaveBeenCalledTimes(1);
    // Chưa gửi được (retry của job): vẫn nhận lại dòng để gửi.
    await n.run(id);
    expect(n.deliver).toHaveBeenCalledTimes(2);
    const [row] = await f.q(
      `select id from notifications where payload->>'absenceRequestId' = $1`,
      [id],
    );
    await f.q(
      `insert into notification_deliveries (id, notification_id, channel, status, sent_at) values ($1, $2, 'push', 'sent', now())`,
      [randomUUID(), row.id],
    );
    await n.run(id);
    expect(n.deliver).toHaveBeenCalledTimes(2);
  });

  it('thông báo: student_absence_reported tới chủ tenant, không ghi chú; idempotent; bỏ qua khi đã hủy', async () => {
    const { AbsenceReportedNotifier } =
      await import('../libs/modules/notifications/application/absence-reported-notifier.service.js');
    const schema = await import('../libs/db/src/schema/index.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const deliver = vi.fn().mockResolvedValue(true);
    const notifier = new AbsenceReportedNotifier(
      new TxService(drizzle(t.worker, { schema, casing: 'snake_case' })),
      { deliver } as never,
    );
    const c = await kid(A, P1);
    const s = await session(A, c.classId, 24);
    const r = (
      await report(P1, s, c.studentId, { note: 'bí mật y tế' })
    ).json() as Report;
    const job = {
      eventId: randomUUID(),
      tenantId: A.tenantId,
      payload: { absenceRequestId: r.id },
    };
    await notifier.handle(job);
    await notifier.handle(job);
    const rows = await f.q(
      `select recipient_user_id, type, urgency, payload from notifications where type = 'student_absence_reported' and payload->>'absenceRequestId' = $1`,
      [r.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_user_id: A.userId,
      urgency: 'normal',
      payload: {
        absenceRequestId: r.id,
        studentId: c.studentId,
        sessionId: s,
        className: 'Toán 9A',
        reason: 'sick',
      },
    });
    expect(JSON.stringify(rows)).not.toContain('bí mật y tế');
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: A.userId,
        type: 'student_absence_reported',
        urgent: false,
      }),
    );

    // Đã hủy trước khi worker chạy → không thông báo.
    const c2 = await kid(A, P1);
    const s2 = await session(A, c2.classId, 24);
    const r2 = (await report(P1, s2, c2.studentId)).json() as Report;
    await req(P1.token, 'DELETE', `/family/absence-requests/${r2.id}`);
    await notifier.handle({
      eventId: randomUUID(),
      tenantId: A.tenantId,
      payload: { absenceRequestId: r2.id },
    });
    expect(
      await f.q(
        `select 1 from notifications where payload->>'absenceRequestId' = $1`,
        [r2.id],
      ),
    ).toHaveLength(0);
  });
});
