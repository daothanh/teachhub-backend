import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };
type Item = {
  id: string;
  sessionDate: string;
  startsAt: string;
  endsAt: string;
  status: string;
  isMakeup: boolean;
  cancelReason: string | null;
  makeupOf: string | null;
};

const DAY = 86_400_000;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ho_Chi_Minh',
}).format(new Date());
const nextMonday = (() => {
  let d = addDays(today, 1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
})();
const RULES = [
  { weekday: 2, startTime: '18:00', durationMin: 90 },
  { weekday: 4, startTime: '18:00', durationMin: 90 },
];
/** Giờ ở tương lai xa hơn mọi buổi của lớp thử, theo +07:00. */
const at = (days: number, hhmm = '18:00') =>
  `${addDays(nextMonday, days)}T${hhmm}:00+07:00`;

// S4-BE-07: dời, hủy, tạo buổi bù (US-2.2 AC1, AC2, AC4).
describe('session changes: reschedule / cancel / makeup', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;

  const call = (
    who: Who,
    method: 'GET' | 'POST' | 'PUT',
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
  /** Lớp 2 tuần với T3 + T5: 4 buổi dự kiến, sắp theo giờ. */
  const newClass = async (who: Who) => {
    const res = await call(who, 'POST', '/classes', {
      name: 'Toán 9A',
      subject: 'Toán',
      grade: 9,
      mode: 'online',
      startDate: nextMonday,
      endDate: addDays(nextMonday, 13),
    });
    expect(res.statusCode, res.body).toBe(201);
    const classId = res.json().id as string;
    const put = await call(who, 'PUT', `/classes/${classId}/schedule-rules`, {
      rules: RULES,
    });
    expect(put.statusCode, put.body).toBe(200);
    return classId;
  };
  const list = async (who: Who, classId: string): Promise<Item[]> => {
    const res = await call(
      who,
      'GET',
      `/sessions?from=${nextMonday}&to=${addDays(nextMonday, 30)}&classId=${classId}`,
    );
    return res.json().items;
  };
  const events = async (who: Who) =>
    (
      await t.worker.query(
        `select payload from outbox_events where tenant_id = $1 and type = 'schedule_changed' order by created_at, id`,
        [who.tenantId],
      )
    ).rows.map((r) => r.payload);
  const reschedule = (who: Who, id: string, body: object, key?: string) =>
    call(who, 'POST', `/sessions/${id}/reschedule`, body, key);
  const cancel = (who: Who, id: string, body: object = {}) =>
    call(who, 'POST', `/sessions/${id}/cancel`, body);
  const makeup = (who: Who, id: string, body: object) =>
    call(who, 'POST', `/sessions/${id}/makeup`, body);

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
  }, 180_000);
  afterAll(() => t?.stop());

  it('AC1: dời buổi planned → ngày/giờ mới, giữ thời lượng, ghi outbox kèm lý do; PUT lại lịch không xóa hay sinh lại', async () => {
    const classId = await newClass(A);
    const [first] = await list(A, classId);
    const res = await reschedule(A, first!.id, {
      startsAt: at(5, '09:00'),
      reason: 'Cô bận việc đột xuất',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: first!.id,
      status: 'planned',
      sessionDate: addDays(nextMonday, 5),
      startsAt: at(5, '09:00'),
      endsAt: at(5, '10:30'),
    });
    const ev = (await events(A)).at(-1);
    expect(ev).toMatchObject({
      change: 'rescheduled',
      sessionId: first!.id,
      classId,
      reason: 'Cô bận việc đột xuất',
    });

    // Job/PUT sinh lịch chạy lại: buổi đã dời còn nguyên, khung giờ gốc không bị sinh lại.
    const again = await call(A, 'PUT', `/classes/${classId}/schedule-rules`, {
      rules: RULES,
    });
    expect(again.json()).toMatchObject({
      sessionsGenerated: 0,
      sessionsRemoved: 0,
    });
    const items = await list(A, classId);
    expect(items).toHaveLength(4);
    expect(items.find((s) => s.id === first!.id)?.startsAt).toBe(
      at(5, '09:00'),
    );
    // Đổi bộ quy tắc (bỏ T3): buổi đã dời vẫn không bị xóa.
    await call(A, 'PUT', `/classes/${classId}/schedule-rules`, {
      rules: [RULES[1]],
    });
    expect((await list(A, classId)).map((s) => s.id)).toContain(first!.id);
  });

  it('dời: quá khứ → 422, buổi đã dạy → 409 CONFLICT_STALE, buổi đã hủy → 409 SESSION_CANCELLED, thiếu Idempotency-Key → 422', async () => {
    const classId = await newClass(A);
    const [s1, s2, s3] = await list(A, classId);
    const past = await reschedule(A, s1!.id, {
      startsAt: `${addDays(today, -1)}T18:00:00+07:00`,
    });
    expect(past.statusCode).toBe(422);
    expect(past.json().code).toBe('VALIDATION_FAILED');

    await t.worker.query(
      `update sessions set status = 'taught' where id = $1`,
      [s2!.id],
    );
    const taught = await reschedule(A, s2!.id, { startsAt: at(6) });
    expect([taught.statusCode, taught.json().code]).toEqual([
      409,
      'CONFLICT_STALE',
    ]);

    await cancel(A, s3!.id);
    const cancelled = await reschedule(A, s3!.id, { startsAt: at(6) });
    expect([cancelled.statusCode, cancelled.json().code]).toEqual([
      409,
      'SESSION_CANCELLED',
    ]);

    const noKey = await call(
      A,
      'POST',
      `/sessions/${s1!.id}/reschedule`,
      { startsAt: at(6) },
      null,
    );
    expect(noKey.statusCode).toBe(422);
  });

  it('dời: cùng Idempotency-Key gửi lại → phát lại kết quả, chỉ một sự kiện outbox', async () => {
    const classId = await newClass(A);
    const [s] = await list(A, classId);
    const key = randomUUID();
    const before = (await events(A)).length;
    const first = await reschedule(A, s!.id, { startsAt: at(6) }, key);
    const second = await reschedule(A, s!.id, { startsAt: at(6) }, key);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect((await events(A)).length).toBe(before + 1);
  });

  it('AC2: buổi đã có điểm danh (kể cả đã dạy) → hủy/dời 409 SESSION_HAS_ATTENDANCE, buổi giữ nguyên', async () => {
    const classId = await newClass(A);
    const [s1, s2] = await list(A, classId);
    const student = randomUUID();
    await t.worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Nam')`,
      [student, A.tenantId],
    );
    await t.worker.query(
      `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at)
       values ($1, $2, $3, $4, 'present', now())`,
      [randomUUID(), A.tenantId, s1!.id, student],
    );
    const before = (await events(A)).length;
    const res = await cancel(A, s1!.id, { reason: 'Nghỉ' });
    expect([res.statusCode, res.json().code]).toEqual([
      409,
      'SESSION_HAS_ATTENDANCE',
    ]);
    // dời buổi planned đã có điểm danh cũng bị chặn, giờ giữ nguyên
    const moved = await reschedule(A, s1!.id, { startsAt: at(6) });
    expect([moved.statusCode, moved.json().code]).toEqual([
      409,
      'SESSION_HAS_ATTENDANCE',
    ]);
    // buổi đã dạy chưa có dòng điểm danh cũng bị chặn
    await t.worker.query(
      `update sessions set status = 'taught' where id = $1`,
      [s2!.id],
    );
    expect((await cancel(A, s2!.id)).json().code).toBe(
      'SESSION_HAS_ATTENDANCE',
    );
    expect((await list(A, classId))[0]).toMatchObject({
      id: s1!.id,
      status: 'planned',
      cancelReason: null,
      startsAt: s1!.startsAt,
    });
    expect((await events(A)).length).toBe(before);
  });

  it('hủy: lý do tùy chọn ≤ 300, ghi outbox; hủy lại → 200 không đổi và không gửi lần hai; PUT lại lịch không sinh lại buổi đã hủy', async () => {
    const classId = await newClass(A);
    const [s] = await list(A, classId);
    const before = (await events(A)).length;
    const res = await cancel(A, s!.id, { reason: 'Cô ốm' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: s!.id,
      status: 'cancelled',
      cancelReason: 'Cô ốm',
    });
    expect((await events(A)).length).toBe(before + 1);
    expect((await events(A)).at(-1)).toMatchObject({
      change: 'cancelled',
      sessionId: s!.id,
      reason: 'Cô ốm',
    });

    const again = await cancel(A, s!.id, { reason: 'Lý do khác' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Cô ốm',
    });
    expect((await events(A)).length).toBe(before + 1);

    const same = await call(A, 'PUT', `/classes/${classId}/schedule-rules`, {
      rules: RULES,
    });
    expect(same.json()).toMatchObject({
      sessionsGenerated: 0,
      sessionsRemoved: 0,
    });
    const items = await list(A, classId);
    expect(items.map((x) => x.status)).toEqual([
      'cancelled',
      'planned',
      'planned',
      'planned',
    ]);
    expect(items[0]!.cancelReason).toBe('Cô ốm');

    const [, s2] = items;
    expect((await cancel(A, s2!.id, {})).json().cancelReason).toBeNull();
    const long = await cancel(A, items[2]!.id, { reason: 'x'.repeat(301) });
    expect(long.statusCode).toBe(422);
  });

  it('AC4: buổi bù chỉ từ buổi đã hủy, liên kết makeupOf, isMakeup, tối đa một cho mỗi buổi gốc; lịch lặp không xóa buổi bù', async () => {
    const classId = await newClass(A);
    const [s] = await list(A, classId);
    const planned = await makeup(A, s!.id, { startsAt: at(20) });
    expect([planned.statusCode, planned.json().code]).toEqual([
      409,
      'CONFLICT_STALE',
    ]);

    await cancel(A, s!.id, { reason: 'Cô ốm' });
    const res = await makeup(A, s!.id, { startsAt: at(20, '19:00') });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      classId,
      status: 'planned',
      isMakeup: true,
      makeupOf: s!.id,
      startsAt: at(20, '19:00'),
      endsAt: at(20, '20:30'), // thời lượng gốc 90 phút
      cancelReason: null,
    });
    expect((await events(A)).at(-1)).toMatchObject({
      change: 'makeup',
      makeupOf: s!.id,
      classId,
    });

    const second = await makeup(A, s!.id, { startsAt: at(21) });
    expect([second.statusCode, second.json().code]).toEqual([
      409,
      'CONFLICT_STALE',
    ]);

    // Đổi bộ quy tắc: buổi bù và buổi gốc đã hủy còn nguyên.
    await call(A, 'PUT', `/classes/${classId}/schedule-rules`, { rules: [] });
    const items = await list(A, classId);
    expect(items.filter((x) => x.isMakeup)).toHaveLength(1);
    expect(items.find((x) => x.id === s!.id)?.status).toBe('cancelled');
    const custom = await makeup(
      A,
      items.find((x) => x.status === 'cancelled')!.id,
      {
        startsAt: at(22),
      },
    );
    expect(custom.statusCode).toBe(409); // gốc đã có buổi bù
  });

  it('buổi bù đã hủy thì cho tạo buổi bù mới cho buổi gốc', async () => {
    const classId = await newClass(A);
    const [s] = await list(A, classId);
    await cancel(A, s!.id);
    const first = await makeup(A, s!.id, { startsAt: at(20) });
    expect(first.statusCode, first.body).toBe(201);
    expect((await cancel(A, first.json().id)).statusCode).toBe(200);
    const next = await makeup(A, s!.id, { startsAt: at(21) });
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json()).toMatchObject({ makeupOf: s!.id, isMakeup: true });
    expect((await makeup(A, s!.id, { startsAt: at(22) })).statusCode).toBe(409);
  });

  it('buổi bù nhận thời lượng mới nếu gửi durationMin', async () => {
    const classId = await newClass(A);
    const [s] = await list(A, classId);
    await cancel(A, s!.id);
    const res = await makeup(A, s!.id, {
      startsAt: at(20, '08:00'),
      durationMin: 60,
    });
    expect(res.json()).toMatchObject({ endsAt: at(20, '09:00') });
  });

  it('chéo tenant và vai trò: B không đụng buổi của A (404), nhân sự không phải chủ → 403', async () => {
    const classId = await newClass(A);
    const [s] = await list(A, classId);
    for (const [path, body] of [
      ['reschedule', { startsAt: at(6) }],
      ['cancel', {}],
      ['makeup', { startsAt: at(6) }],
    ] as const) {
      const res = await call(B, 'POST', `/sessions/${s!.id}/${path}`, body);
      expect([path, res.statusCode]).toEqual([path, 404]);
    }
    expect((await list(A, classId))[0]).toMatchObject({
      id: s!.id,
      status: 'planned',
      startsAt: s!.startsAt,
    });
    const teacher = await seedMember(t.worker, A.tenantId, 'teacher');
    const res = await call(
      { ...A, token: await t.tokenFor(teacher) },
      'POST',
      `/sessions/${s!.id}/cancel`,
      {},
    );
    expect(res.statusCode).toBe(403);
  });
});
