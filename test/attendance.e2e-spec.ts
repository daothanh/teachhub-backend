import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };
type Status = 'present' | 'late' | 'excused' | 'unexcused';

const DAY = 86_400_000;
const TZ = 'Asia/Ho_Chi_Minh';
const dateOf = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const daysAgo = (n: number) => dateOf(new Date(Date.now() - n * DAY));

// S3-BE-02: GET /sessions/{id}/attendance và POST /attendance/sync (US-3.1 AC4, US-3.3 AC1, US-3.5 AC2-AC3).
describe('điểm danh API', () => {
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

  /** Lớp + buổi (ngày theo giờ VN) + `n` học viên đang học, dựng bằng worker (bỏ qua RLS). */
  async function world(
    who: SeededTenant,
    opts: { date?: string; n?: number; status?: string } = {},
  ) {
    const classId = randomUUID();
    const sessionId = randomUUID();
    const date = opts.date ?? dateOf(new Date());
    await t.worker.query(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
       values ($1, $2, $3, 'Toán 9A', 'Toán', 9, 'online', $4)`,
      [classId, who.tenantId, who.branchId, daysAgo(60)],
    );
    await t.worker.query(
      `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at, status)
       values ($1, $2, $3, $4, ($4::date + time '18:00') at time zone '${TZ}',
               ($4::date + time '19:30') at time zone '${TZ}', $5)`,
      [sessionId, who.tenantId, classId, date, opts.status ?? 'planned'],
    );
    const studentIds: string[] = [];
    for (let i = 0; i < (opts.n ?? 3); i++) {
      const id = randomUUID();
      studentIds.push(id);
      await t.worker.query(
        `insert into students (id, tenant_id, full_name) values ($1, $2, $3)`,
        [id, who.tenantId, `Học viên ${String(i).padStart(2, '0')}`],
      );
      await t.worker.query(
        `insert into enrollments (id, tenant_id, class_id, student_id, joined_on) values ($1, $2, $3, $4, $5)`,
        [randomUUID(), who.tenantId, classId, id, daysAgo(30)],
      );
    }
    return { classId, sessionId, studentIds };
  }

  const mut = (
    studentId: string,
    status: Status,
    over: Partial<{
      clientMutationId: string;
      clientUpdatedAt: string;
      note: string | null;
    }> = {},
  ) => ({
    clientMutationId: randomUUID(),
    studentId,
    status,
    note: null,
    clientUpdatedAt: new Date().toISOString(),
    ...over,
  });
  const batch = (
    sessionId: string,
    mutations: object[],
    over: object = {},
  ) => ({
    deviceId: randomUUID(),
    deviceTime: new Date().toISOString(),
    sessionId,
    markSessionTaught: false,
    mutations,
    ...over,
  });
  const outbox = async (who: SeededTenant) =>
    (
      await t.worker.query(
        `select type, payload from outbox_events where tenant_id = $1 order by created_at`,
        [who.tenantId],
      )
    ).rows as { type: string; payload: { changes: object[] } }[];

  beforeAll(async () => {
    t = await startTestApp();
    for (const slot of ['A', 'B'] as const) {
      const s = await seedTenant(t.worker);
      const who = { ...s, token: await t.tokenFor(s.userId) };
      if (slot === 'A') A = who;
      else B = who;
    }
  }, 180_000);

  afterAll(async () => {
    await t?.stop();
  });

  it('GET: mọi học viên đang học, chưa có dòng → status null; canEdit và hạn sửa', async () => {
    const w = await world(A);
    const res = await call(A, 'GET', `/sessions/${w.sessionId}/attendance`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    expect(
      body.items.every((i: { status: unknown }) => i.status === null),
    ).toBe(true);
    expect(body.canEdit).toBe(true);
    expect(body.editableUntil).toMatch(
      new RegExp(
        `^${dateOf(new Date(Date.now() + 7 * DAY))}T23:59:59\\+07:00$`,
      ),
    );
    expect(body.summary).toEqual({
      present: 0,
      late: 0,
      excused: 0,
      unexcused: 0,
    });
  });

  it('lưu online: buổi chuyển "đã dạy", học viên không có trong lô là "Có mặt", ≤ 1 giây (US-3.1 AC4)', async () => {
    const w = await world(A, { n: 30 });
    const started = Date.now();
    const res = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [mut(w.studentIds[0]!, 'unexcused')], {
        markSessionTaught: true,
      }),
    );
    const took = Date.now() - started;
    expect(res.statusCode, res.body).toBe(200);
    expect(took).toBeLessThan(1000);
    const body = res.json();
    expect(body.sessionStatus).toBe('taught');
    expect(body.results[0].result).toBe('applied');
    expect(body.summary).toEqual({
      present: 29,
      late: 0,
      excused: 0,
      unexcused: 1,
    });
    expect(body.parentsToNotify).toBe(0);
    const { rows } = await t.worker.query(
      `select count(*)::int as n from attendance where session_id = $1`,
      [w.sessionId],
    );
    expect(rows[0].n).toBe(30);
    const events = (await outbox(A)).filter(
      (e) => (e.payload as { sessionId?: string }).sessionId === w.sessionId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('attendance_recorded');
    expect(events[0]!.payload.changes).toHaveLength(1); // dòng "Có mặt" tạo ngầm không vào outbox
    // Buổi đã dạy: gửi lại cờ không lỗi.
    const again = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [mut(w.studentIds[1]!, 'late')], {
        markSessionTaught: true,
      }),
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().sessionStatus).toBe('taught');
  });

  it('replay cùng Idempotency-Key trả đúng phản hồi cũ, không ghi thêm; id mutation gửi lại (key mới) → duplicate', async () => {
    const w = await world(A);
    const key = randomUUID();
    const m = mut(w.studentIds[0]!, 'excused', { note: 'Ốm' });
    const body = batch(w.sessionId, [m]);
    const first = await call(A, 'POST', '/attendance/sync', body, key);
    // Thiết bị trôi giờ giữa hai lần gửi: retry cùng body (client giữ nguyên deviceTime) → phản hồi đã lưu.
    const replay = await call(A, 'POST', '/attendance/sync', body, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    const dup = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [m]),
    );
    expect(dup.json().results[0]).toMatchObject({
      result: 'duplicate',
      current: { status: 'excused', note: 'Ốm' },
    });
    const events = (await outbox(A)).filter(
      (e) => (e.payload as { sessionId?: string }).sessionId === w.sessionId,
    );
    expect(events).toHaveLength(1);
  });

  it('LWW: sửa mới hơn thắng, cũ hơn hoặc bằng → stale kèm current; hai thiết bị không tạo dòng trùng (US-3.5 AC2-AC3)', async () => {
    const w = await world(A);
    const s = w.studentIds[0]!;
    const t0 = Date.now();
    const iso = (ms: number) => new Date(t0 + ms).toISOString();
    const send = (m: object) =>
      call(A, 'POST', '/attendance/sync', batch(w.sessionId, [m]));
    const first = await send(
      mut(s, 'unexcused', { clientUpdatedAt: iso(-60_000) }),
    );
    expect(first.json().results[0].result).toBe('applied');
    const older = await send(
      mut(s, 'present', { clientUpdatedAt: iso(-120_000) }),
    );
    expect(older.json().results[0]).toMatchObject({
      result: 'stale',
      current: { status: 'unexcused' },
    });
    const newer = await send(
      mut(s, 'present', { clientUpdatedAt: iso(-1_000) }),
    );
    expect(newer.json().results[0].result).toBe('applied');
    const { rows } = await t.worker.query(
      `select status from attendance where session_id = $1 and student_id = $2`,
      [w.sessionId, s],
    );
    expect(rows).toEqual([{ status: 'present' }]);
    const events = (await outbox(A)).filter(
      (e) => (e.payload as { sessionId?: string }).sessionId === w.sessionId,
    );
    expect(events).toHaveLength(2); // hai lần applied; stale không sinh sự kiện
    // Cả hai lần sửa nằm trong nhật ký (nguồn của /attendance/history).
    const audit = await t.worker.query(
      `select count(*)::int as n from audit_logs where tenant_id = $1 and entity = 'attendance'
         and after_data->>'session_id' = $2`,
      [A.tenantId, w.sessionId],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('hiệu chỉnh lệch đồng hồ: thiết bị chậm 10 phút vẫn thắng bản cũ hơn theo giờ thật', async () => {
    const w = await world(A);
    const s = w.studentIds[0]!;
    const now = Date.now();
    // Thiết bị 1 (đồng hồ đúng) sửa cách đây 60 giây.
    await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [
        mut(s, 'unexcused', {
          clientUpdatedAt: new Date(now - 60_000).toISOString(),
        }),
      ]),
    );
    // Thiết bị 2 chậm 10 phút: giờ thô của lần sửa (now-610s) sớm hơn nhiều, nhưng thật ra mới sửa cách đây 10 giây.
    const slow = (ms: number) => new Date(now - 600_000 + ms).toISOString();
    const res = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(
        w.sessionId,
        [mut(s, 'present', { clientUpdatedAt: slow(-10_000) })],
        {
          deviceTime: slow(0),
        },
      ),
    );
    expect(res.json().results[0].result).toBe('applied');
    // Giờ sửa của thiết bị nhanh 5 ngày bị kẹp về giờ nhận: vẫn thắng bản cũ nhưng không vượt giờ máy chủ.
    const future = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(
        w.sessionId,
        [
          mut(s, 'late', {
            clientUpdatedAt: new Date(now + 5 * DAY).toISOString(),
          }),
        ],
        { deviceTime: new Date(now + 5 * DAY).toISOString() },
      ),
    );
    expect(future.json().results[0].result).toBe('applied'); // kẹp về giờ nhận, vẫn mới hơn
    const after = await t.worker.query(
      `select client_updated_at <= now() as ok from attendance where session_id = $1 and student_id = $2`,
      [w.sessionId, s],
    );
    expect(after.rows[0].ok).toBe(true);
  });

  it('cửa sổ 7 ngày theo ngày buổi học: ngày thứ 7 còn sửa, ngày thứ 8 → rejected; GET canEdit = false', async () => {
    const open = await world(A, { date: daysAgo(7) });
    const ok = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(open.sessionId, [mut(open.studentIds[0]!, 'late')]),
    );
    expect(ok.json().results[0].result).toBe('applied');

    const closed = await world(A, { date: daysAgo(8) });
    const res = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(closed.sessionId, [mut(closed.studentIds[0]!, 'late')], {
        markSessionTaught: true,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({
      result: 'rejected',
      errorCode: 'ATTENDANCE_EDIT_WINDOW_CLOSED',
    });
    expect(res.json().sessionStatus).toBe('planned'); // quá hạn: không chuyển đã dạy
    const view = await call(
      A,
      'GET',
      `/sessions/${closed.sessionId}/attendance`,
    );
    expect(view.json().canEdit).toBe(false);
  });

  it('buổi đã hủy → 409 SESSION_CANCELLED cả lô', async () => {
    const w = await world(A, { status: 'cancelled' });
    const res = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [mut(w.studentIds[0]!, 'present')]),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SESSION_CANCELLED');
  });

  it('chéo tenant: B không đọc/ghi buổi của A (404); học viên tenant khác và học viên ngoài lớp cho cùng kết quả', async () => {
    const wa = await world(A);
    const wb = await world(B);
    expect(
      (await call(B, 'GET', `/sessions/${wa.sessionId}/attendance`)).statusCode,
    ).toBe(404);
    const writeA = await call(
      B,
      'POST',
      '/attendance/sync',
      batch(wa.sessionId, [mut(wa.studentIds[0]!, 'unexcused')]),
    );
    expect(writeA.statusCode).toBe(404);
    const { rows } = await t.worker.query(
      `select count(*)::int as n from attendance where session_id = $1`,
      [wa.sessionId],
    );
    expect(rows[0].n).toBe(0);

    // Học viên của tenant A trong buổi của B, và học viên của B nhưng không thuộc lớp của buổi.
    const outsider = randomUUID();
    await t.worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Ngoài lớp')`,
      [outsider, B.tenantId],
    );
    const normalize = (r: { json: () => { results: object[] } }) =>
      r.json().results.map((x) => ({
        ...x,
        clientMutationId: undefined,
        studentId: undefined,
      }));
    const otherTenant = await call(
      B,
      'POST',
      '/attendance/sync',
      batch(wb.sessionId, [mut(wa.studentIds[0]!, 'unexcused')]),
    );
    const notInClass = await call(
      B,
      'POST',
      '/attendance/sync',
      batch(wb.sessionId, [mut(outsider, 'unexcused')]),
    );
    expect(normalize(otherTenant)).toEqual([
      { result: 'rejected', errorCode: 'NOT_FOUND' },
    ]);
    expect(normalize(notInClass)).toEqual(normalize(otherTenant));
    expect(otherTenant.json().summary).toEqual(notInClass.json().summary);
  });

  it('dedupe theo tenant: cùng clientMutationId ở tenant khác vẫn applied; id đã dùng ở buổi khác → rejected NOT_FOUND, không lộ', async () => {
    const wa = await world(A);
    const wb = await world(B);
    const id = randomUUID();
    const a = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(wa.sessionId, [
        mut(wa.studentIds[0]!, 'late', { clientMutationId: id }),
      ]),
    );
    expect(a.json().results[0].result).toBe('applied');
    const b = await call(
      B,
      'POST',
      '/attendance/sync',
      batch(wb.sessionId, [
        mut(wb.studentIds[0]!, 'late', { clientMutationId: id }),
      ]),
    );
    expect(b.json().results[0].result).toBe('applied');
    const other = await world(A);
    const clash = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(other.sessionId, [
        mut(other.studentIds[0]!, 'late', { clientMutationId: id }),
      ]),
    );
    expect(clash.json().results[0]).toMatchObject({
      result: 'rejected',
      errorCode: 'NOT_FOUND',
    });
    expect(clash.json().results[0].current).toBeUndefined();
  });

  it('vắng không phép: outbox có thay đổi và parentsToNotify đếm phụ huynh đã liên kết', async () => {
    const w = await world(A);
    const parent = randomUUID();
    await t.worker.query(`insert into users (id, email) values ($1, $2)`, [
      parent,
      `${parent}@example.com`,
    ]);
    await t.worker.query(
      `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'PH', $4)`,
      [randomUUID(), A.tenantId, w.studentIds[0], parent],
    );
    const res = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [
        mut(w.studentIds[0]!, 'unexcused'),
        mut(w.studentIds[1]!, 'unexcused'),
      ]),
    );
    expect(res.json().parentsToNotify).toBe(1);
  });

  it('lô không hợp lệ: trùng clientMutationId trong lô, quá 500 phần tử → 422', async () => {
    const w = await world(A);
    const m = mut(w.studentIds[0]!, 'present');
    const dup = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [m, m]),
    );
    expect(dup.statusCode).toBe(422);
    const big = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(
        w.sessionId,
        Array.from({ length: 501 }, () => mut(w.studentIds[0]!, 'present')),
      ),
    );
    expect(big.statusCode).toBe(422);
  });
  it('nhật ký sửa (US-3.3 AC2): mới nhất trước, trước/sau, chỉ tên người sửa, phân trang con trỏ', async () => {
    await t.worker.query(
      `update users set display_name = 'Cô Lan' where id = $1`,
      [A.userId],
    );
    const w = await world(A);
    const s = w.studentIds[0]!;
    const t0 = Date.now();
    for (const [status, ms, note] of [
      ['unexcused', -60_000, null],
      ['present', -1_000, 'Nhầm trạng thái'],
    ] as const) {
      await call(
        A,
        'POST',
        '/attendance/sync',
        batch(w.sessionId, [
          mut(s, status, {
            clientUpdatedAt: new Date(t0 + ms).toISOString(),
            note,
          }),
        ]),
      );
    }
    const res = await call(
      A,
      'GET',
      `/sessions/${w.sessionId}/attendance/history`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const { items, nextCursor } = res.json();
    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      studentId: s,
      studentName: 'Học viên 00',
      changedByName: 'Cô Lan',
      before: { status: 'unexcused', note: null },
      after: { status: 'present', note: 'Nhầm trạng thái' },
    });
    expect(items[1]).toMatchObject({
      before: null,
      after: { status: 'unexcused' },
    });
    // Không lộ email hay user id của người sửa.
    expect(res.body).not.toContain(A.userId);
    expect(res.body).not.toContain('@example.com');

    const p1 = await call(
      A,
      'GET',
      `/sessions/${w.sessionId}/attendance/history?limit=1`,
    );
    expect(p1.json().items).toHaveLength(1);
    expect(p1.json().nextCursor).toBeTruthy();
    const p2 = await call(
      A,
      'GET',
      `/sessions/${w.sessionId}/attendance/history?limit=1&cursor=${p1.json().nextCursor}`,
    );
    expect(p2.json().items[0].id).toBe(items[1].id);
    expect(p2.json().nextCursor).toBeNull();
    const bad = await call(
      A,
      'GET',
      `/sessions/${w.sessionId}/attendance/history?cursor=bay-ro`,
    );
    expect(bad.statusCode).toBe(422);
  });

  it('nhật ký chéo tenant: B không xem được buổi của A (404); chỉ tenant_owner xem được (giáo viên thường 403)', async () => {
    const wa = await world(A);
    await call(
      A,
      'POST',
      '/attendance/sync',
      batch(wa.sessionId, [mut(wa.studentIds[0]!, 'late')]),
    );
    const cross = await call(
      B,
      'GET',
      `/sessions/${wa.sessionId}/attendance/history`,
    );
    expect(cross.statusCode).toBe(404);
    const teacher = await seedMember(t.worker, A.tenantId, 'teacher');
    const asTeacher = {
      ...A,
      userId: teacher,
      token: await t.tokenFor(teacher),
    };
    const res = await call(
      asTeacher,
      'GET',
      `/sessions/${wa.sessionId}/attendance/history`,
    );
    expect(res.statusCode).toBe(403);
  });
  it('học viên chỉ đọc (vượt gói): mutation → rejected READONLY_PLAN_LIMIT và không bị tạo dòng "Có mặt" ngầm', async () => {
    const w = await world(A);
    const ro = w.studentIds[2]!;
    await t.worker.query(
      `update students set is_readonly = true where id = $1`,
      [ro],
    );
    const res = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(
        w.sessionId,
        [mut(ro, 'unexcused'), mut(w.studentIds[0]!, 'late')],
        {
          markSessionTaught: true,
        },
      ),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0]).toMatchObject({
      result: 'rejected',
      errorCode: 'READONLY_PLAN_LIMIT',
    });
    expect(res.json().sessionStatus).toBe('taught');
    const { rows } = await t.worker.query(
      `select student_id from attendance where session_id = $1`,
      [w.sessionId],
    );
    const got = rows.map((r) => r.student_id as string).sort();
    expect(got).toEqual([w.studentIds[0]!, w.studentIds[1]!].sort()); // không có dòng của học viên chỉ đọc
    expect(res.json().summary).toEqual({
      present: 1,
      late: 1,
      excused: 0,
      unexcused: 0,
    });
  });

  it('S9: buổi ở tương lai chưa điểm danh được: mutation → rejected ATTENDANCE_EDIT_WINDOW_CLOSED, không chuyển đã dạy, canEdit=false', async () => {
    const w = await world(A, { date: dateOf(new Date(Date.now() + 2 * DAY)) });
    const res = await call(
      A,
      'POST',
      '/attendance/sync',
      batch(w.sessionId, [mut(w.studentIds[0]!, 'present')], {
        markSessionTaught: true,
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0]).toMatchObject({
      result: 'rejected',
      errorCode: 'ATTENDANCE_EDIT_WINDOW_CLOSED',
    });
    expect(res.json().sessionStatus).toBe('planned');
    const view = await call(A, 'GET', `/sessions/${w.sessionId}/attendance`);
    expect(view.json().canEdit).toBe(false);
    const { rows } = await t.worker.query(
      `select 1 from attendance where session_id = $1`,
      [w.sessionId],
    );
    expect(rows).toHaveLength(0);
  });

  it('S7: gửi lại đúng trạng thái và ghi chú (id mutation mới) → applied nhưng không ghi, không audit, không outbox thừa', async () => {
    const w = await world(A);
    const s = w.studentIds[0]!;
    const send = (m: object) =>
      call(A, 'POST', '/attendance/sync', batch(w.sessionId, [m]));
    const t0 = Date.now();
    await send(
      mut(s, 'late', { clientUpdatedAt: new Date(t0 - 60_000).toISOString() }),
    );
    const res = await send(
      mut(s, 'late', { clientUpdatedAt: new Date(t0 - 1_000).toISOString() }),
    );
    expect(res.json().results[0].result).toBe('applied');
    const audit = await t.worker.query(
      `select count(*)::int as n from audit_logs where tenant_id = $1 and entity = 'attendance' and after_data->>'session_id' = $2`,
      [A.tenantId, w.sessionId],
    );
    expect(audit.rows[0].n).toBe(1);
    const events = (await outbox(A)).filter(
      (e) => (e.payload as { sessionId?: string }).sessionId === w.sessionId,
    );
    expect(events).toHaveLength(1);
  });

  it('S5: hai lô khác buổi cùng clientMutationId chạy đồng thời → không có 500, chỉ một bên applied', async () => {
    const w1 = await world(A);
    const w2 = await world(A);
    const id = randomUUID();
    const [r1, r2] = await Promise.all([
      call(
        A,
        'POST',
        '/attendance/sync',
        batch(w1.sessionId, [
          mut(w1.studentIds[0]!, 'late', { clientMutationId: id }),
        ]),
      ),
      call(
        A,
        'POST',
        '/attendance/sync',
        batch(w2.sessionId, [
          mut(w2.studentIds[0]!, 'late', { clientMutationId: id }),
        ]),
      ),
    ]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    const results = [r1, r2]
      .map((r) => r.json().results[0].result as string)
      .sort();
    expect(results).toEqual(['applied', 'rejected']);
  });
});
