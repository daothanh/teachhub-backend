import { randomUUID } from 'node:crypto';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };
type Rule = { weekday: number; startTime: string; durationMin: number };

const DAY = 86_400_000;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ho_Chi_Minh',
}).format(new Date());
/** Thứ Hai kế tiếp (sau hôm nay ít nhất một ngày): mọi buổi từ đó đều ở tương lai. */
const nextMonday = (() => {
  let d = addDays(today, 1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
})();
const T3: Rule = { weekday: 2, startTime: '18:00', durationMin: 90 };
const T5: Rule = { weekday: 4, startTime: '18:00', durationMin: 90 };

// S2-BE-08: PUT /classes/{id}/schedule-rules + GET /sessions (US-2.1 AC1-AC3).
describe('schedule API', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;

  const call = (
    who: Who,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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
      startDate: nextMonday,
      endDate: addDays(nextMonday, 13),
      ...over,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const put = (who: Who, classId: string, rules: Rule[], key?: string) =>
    call(who, 'PUT', `/classes/${classId}/schedule-rules`, { rules }, key);
  const list = async (who: Who, query: string) => {
    const res = await call(who, 'GET', `/sessions?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items as {
      id: string;
      classId: string;
      className: string;
      sessionDate: string;
      startsAt: string;
      endsAt: string;
      status: string;
      isMakeup: boolean;
    }[];
  };
  const rows = async (sql: string, params: unknown[]) =>
    (await t.worker.query(sql, params)).rows;

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async (): Promise<Who> => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    [A, B] = [await mk(), await mk()];
  }, 180_000);
  afterAll(() => t?.stop());

  it('AC1: lớp có ngày kết thúc, T3 + T5 18:00 90 phút → sinh đúng buổi, giờ +07:00, sắp theo giờ', async () => {
    const id = await newClass(A);
    const res = await put(A, id, [T5, T3]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      sessionsGenerated: 4,
      sessionsRemoved: 0,
    });
    expect(res.json().rules.map((r: Rule) => r.weekday)).toEqual([2, 4]);
    expect(res.json().rules[0]).toMatchObject({
      startTime: '18:00',
      durationMin: 90,
    });
    const items = await list(
      A,
      `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
    );
    expect(items.map((s) => s.sessionDate)).toEqual([
      addDays(nextMonday, 1),
      addDays(nextMonday, 3),
      addDays(nextMonday, 8),
      addDays(nextMonday, 10),
    ]);
    expect(items[0]).toMatchObject({
      classId: id,
      className: 'Toán 9A',
      startsAt: `${addDays(nextMonday, 1)}T18:00:00+07:00`,
      endsAt: `${addDays(nextMonday, 1)}T19:30:00+07:00`,
      status: 'planned',
      isMakeup: false,
    });
    const cls = (await call(A, 'GET', `/classes/${id}`)).json();
    expect(
      cls.scheduleRules.map((r: Rule) => [r.weekday, r.startTime]),
    ).toEqual([
      [2, '18:00'],
      [4, '18:00'],
    ]);
  });

  it('AC2: lớp không có ngày kết thúc → cuốn chiếu 8 tuần (16 buổi)', async () => {
    const id = await newClass(A, { endDate: null });
    const res = await put(A, id, [T3, T5]);
    expect(res.json().sessionsGenerated).toBe(16);
    const dates = (
      await rows(
        `select session_date::text d from sessions where class_id = $1 order by 1`,
        [id],
      )
    ).map((r) => r.d);
    expect(dates.at(-1)).toBe(addDays(nextMonday, 8 * 7 - 4)); // thứ Năm của tuần thứ 8
  });

  it('lớp đã bắt đầu: chỉ sinh buổi từ hôm nay trở đi, không sinh về quá khứ', async () => {
    const id = await newClass(A, {
      startDate: addDays(today, -30),
      endDate: null,
    });
    await put(A, id, [T3, T5]);
    const dates = (
      await rows(
        `select session_date::text d from sessions where class_id = $1 order by 1`,
        [id],
      )
    ).map((r) => r.d);
    expect(dates.length).toBeGreaterThan(10);
    expect(dates.every((d) => d >= today)).toBe(true);
  });

  it('AC3: thay bộ quy tắc chỉ đổi buổi tương lai dự kiến; buổi đã dạy giữ nguyên; PUT lại cùng nội dung → 0 sinh/0 xóa', async () => {
    const id = await newClass(A);
    await put(A, id, [T3, T5]);
    const before = await list(
      A,
      `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
    );
    const [firstThu] = before.filter(
      (s) => s.sessionDate === addDays(nextMonday, 3),
    );
    await t.worker.query(
      `update sessions set status = 'taught' where id = $1`,
      [firstThu!.id],
    );

    // đổi T5 → T6 (weekday 5): xóa 1 buổi T5 còn dự kiến (buổi đã dạy ở lại), sinh 2 buổi T6
    const res = await put(A, id, [
      T3,
      { weekday: 5, startTime: '18:00', durationMin: 90 },
    ]);
    expect(res.json()).toMatchObject({
      sessionsGenerated: 2,
      sessionsRemoved: 1,
    });
    const after = await list(
      A,
      `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
    );
    expect(after.map((s) => [s.sessionDate, s.status])).toEqual([
      [addDays(nextMonday, 1), 'planned'],
      [addDays(nextMonday, 3), 'taught'],
      [addDays(nextMonday, 4), 'planned'],
      [addDays(nextMonday, 8), 'planned'],
      [addDays(nextMonday, 11), 'planned'],
    ]);
    // buổi T3 của quy tắc không đổi giữ nguyên id
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(
      (
        await rows(`select rule_id from sessions where id = $1`, [firstThu!.id])
      )[0].rule_id,
    ).toBeNull();

    // PUT lại cùng nội dung bằng khóa mới: không sinh, không xóa
    const same = await put(A, id, [
      T3,
      { weekday: 5, startTime: '18:00', durationMin: 90 },
    ]);
    expect(same.json()).toMatchObject({
      sessionsGenerated: 0,
      sessionsRemoved: 0,
    });
    // mảng rỗng: bỏ lịch lặp, giữ buổi đã dạy
    const clear = await put(A, id, []);
    expect(clear.json()).toMatchObject({
      rules: [],
      sessionsGenerated: 0,
      sessionsRemoved: 4,
    });
    expect(
      await list(
        A,
        `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
      ),
    ).toHaveLength(1);
  });

  it('đổi thời lượng cùng thứ + giờ: quy tắc mới thay quy tắc cũ, buổi sinh lại', async () => {
    const id = await newClass(A);
    await put(A, id, [T3]);
    const res = await put(A, id, [{ ...T3, durationMin: 60 }]);
    expect(res.json()).toMatchObject({
      sessionsGenerated: 2,
      sessionsRemoved: 2,
    });
    const items = await list(
      A,
      `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
    );
    expect(items[0]!.endsAt).toBe(`${addDays(nextMonday, 1)}T19:00:00+07:00`);
  });

  it('thu hẹp ngày kết thúc rồi PUT lại: buổi vượt ngày kết thúc bị xóa', async () => {
    const id = await newClass(A);
    await put(A, id, [T3, T5]);
    await call(A, 'PATCH', `/classes/${id}`, {
      endDate: addDays(nextMonday, 6),
    });
    const res = await put(A, id, [T3, T5]);
    expect(res.json()).toMatchObject({
      sessionsGenerated: 0,
      sessionsRemoved: 2,
    });
  });

  it('lớp đã lưu trữ → 409 CONFLICT_STALE và biến khỏi GET /sessions', async () => {
    const id = await newClass(A);
    await put(A, id, [T3]);
    expect(
      await list(
        A,
        `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
      ),
    ).toHaveLength(2);
    await call(A, 'POST', `/classes/${id}/archive`);
    const res = await put(A, id, [T3, T5]);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT_STALE');
    expect(
      await list(
        A,
        `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
      ),
    ).toEqual([]);
  });

  it('gửi lặp cùng Idempotency-Key → phát lại, không sinh trùng', async () => {
    const id = await newClass(A);
    const key = randomUUID();
    const a = await put(A, id, [T3, T5], key);
    const b = await put(A, id, [T3, T5], key);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(
      (
        await rows(`select count(*)::int n from sessions where class_id = $1`, [
          id,
        ])
      )[0].n,
    ).toBe(4);
    expect(
      (
        await rows(
          `select count(*)::int n from schedule_rules where class_id = $1`,
          [id],
        )
      )[0].n,
    ).toBe(2);
  });

  it('GET /sessions: bao gồm hai đầu theo ngày địa phương; buổi 00:30 giờ VN thuộc đúng ngày; quá 62 ngày hoặc to < from → 422', async () => {
    const id = await newClass(A);
    await put(A, id, [{ weekday: 2, startTime: '00:30', durationMin: 30 }]);
    const tue = addDays(nextMonday, 1);
    const one = await list(A, `from=${tue}&to=${tue}&classId=${id}`);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      sessionDate: tue,
      startsAt: `${tue}T00:30:00+07:00`,
    });
    expect(
      await list(
        A,
        `from=${addDays(tue, 1)}&to=${addDays(tue, 6)}&classId=${id}`,
      ),
    ).toEqual([]);
    const far = await call(
      A,
      'GET',
      `/sessions?from=${tue}&to=${addDays(tue, 63)}`,
    );
    expect(far.statusCode).toBe(422);
    expect(
      (await call(A, 'GET', `/sessions?from=${tue}&to=${addDays(tue, 62)}`))
        .statusCode,
    ).toBe(200);
    expect(
      (await call(A, 'GET', `/sessions?from=${tue}&to=${addDays(tue, -1)}`))
        .statusCode,
    ).toBe(422);
  });

  it('quy tắc trùng (thứ + giờ) hoặc vượt 24:00 → 422 theo trường', async () => {
    const id = await newClass(A);
    const dup = await put(A, id, [T3, T3]);
    expect(dup.statusCode).toBe(422);
    expect(Object.keys(dup.json().errors)).toEqual(['rules.1.startTime']);
    const over = await put(A, id, [
      { weekday: 2, startTime: '23:00', durationMin: 90 },
    ]);
    expect(Object.keys(over.json().errors)).toEqual(['rules.0.durationMin']);
  });

  it('tenant B không đặt lịch cho lớp của A (404), không thấy buổi của A, lọc theo classId của A cho danh sách rỗng', async () => {
    const id = await newClass(A);
    await put(A, id, [T3, T5]);
    const res = await put(B, id, [
      { weekday: 1, startTime: '08:00', durationMin: 60 },
    ]);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(
      await list(B, `from=${nextMonday}&to=${addDays(nextMonday, 13)}`),
    ).toEqual([]);
    expect(
      await list(
        B,
        `from=${nextMonday}&to=${addDays(nextMonday, 13)}&classId=${id}`,
      ),
    ).toEqual([]);
    expect(
      (
        await rows(
          `select count(*)::int n from schedule_rules where class_id = $1`,
          [id],
        )
      )[0].n,
    ).toBe(2);
    expect((await call(B, 'GET', `/classes/${id}`)).statusCode).toBe(404);
  });
});
