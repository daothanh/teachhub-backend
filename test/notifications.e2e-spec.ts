import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { TxService } from '@teachhub/db';
import type { PushMessage, PushResult } from '@teachhub/infra';
import * as schema from '../libs/db/src/schema/index.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Change = {
  studentId: string;
  attendanceId: string;
  status: string;
  previousStatus: string | null;
};

// S3-BE-06: processor báo vắng (worker) và GET /notifications + POST /notifications/read.
describe('thông báo báo vắng', () => {
  let t: TestApp;
  let A: SeededTenant;
  let parent: { userId: string; token: string };
  let other: { userId: string; token: string };
  let classId: string;
  let sessionId: string;
  let sent: PushMessage[];
  let behaviour: (m: PushMessage[]) => PushResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let notifier: any;
  const token = `fcm-${randomUUID()}`;

  const ok = (m: PushMessage[]): PushResult[] =>
    m.map(() => ({ ok: true, messageId: 'm1' }));
  const fake = (enabled = true) => ({
    enabled,
    send: (m: PushMessage[]) => {
      sent.push(...m);
      return Promise.resolve(behaviour(m));
    },
  });

  async function student(name: string) {
    const id = randomUUID();
    await t.worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, $3)`,
      [id, A.tenantId, name],
    );
    await t.worker.query(
      `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'PH', $4)`,
      [randomUUID(), A.tenantId, id, parent.userId],
    );
    return id;
  }
  async function user() {
    const userId = randomUUID();
    const m = randomUUID();
    await t.worker.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    await t.worker.query(
      `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
      [m, userId],
    );
    await t.worker.query(
      `update users set last_membership_id = $1 where id = $2`,
      [m, userId],
    );
    return { userId, token: await t.tokenFor(userId) };
  }
  const event = (changes: Change[], recordedAt = new Date()) => ({
    eventId: randomUUID(),
    tenantId: A.tenantId,
    payload: { sessionId, recordedAt: recordedAt.toISOString(), changes },
  });
  const change = (
    studentId: string,
    status: string,
    previousStatus: string | null,
  ): Change => ({
    studentId,
    attendanceId: randomUUID(),
    status,
    previousStatus,
  });
  const get = (who: { token: string }, qs = '') =>
    t.app.inject({
      method: 'GET',
      url: `/v1/notifications${qs}`,
      headers: { authorization: `Bearer ${who.token}` },
    });
  const read = (who: { token: string }, ids: string[]) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      payload: { ids },
      headers: {
        authorization: `Bearer ${who.token}`,
        'idempotency-key': randomUUID(),
      },
    });
  const rows = async (sql: string, p: unknown[] = []) =>
    (await t.worker.query(sql, p)).rows;

  beforeAll(async () => {
    t = await startTestApp();
    A = await seedTenant(t.worker);
    parent = await user();
    other = await user();
    classId = randomUUID();
    sessionId = randomUUID();
    await t.worker.query(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
       values ($1, $2, $3, 'Toán 9A', 'Toán', 9, 'online', '2026-01-01')`,
      [classId, A.tenantId, A.branchId],
    );
    await t.worker.query(
      `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at)
       values ($1, $2, $3, '2026-12-15', '2026-12-15T11:00:00Z', '2026-12-15T12:30:00Z')`,
      [sessionId, A.tenantId, classId],
    );
    await t.worker.query(
      `insert into devices (id, user_id, token, platform) values ($1, $2, $3, 'android')`,
      [randomUUID(), parent.userId, token],
    );
    // import động: @teachhub/core kiểm env khi nạp, mà env chỉ có sau startTestApp.
    const { AbsenceNotifier } =
      await import('../libs/modules/notifications/application/absence-notifier.service.js');
    const wTx = new TxService(
      drizzle(t.worker, { schema, casing: 'snake_case' }),
    );
    sent = [];
    behaviour = ok;
    notifier = new AbsenceNotifier(wTx, fake() as never);
    notifier.push = undefined; // thay ở từng test qua `use`
    notifier.tx = wTx;
  }, 180_000);

  afterAll(async () => t?.stop());

  const use = (enabled = true) => {
    notifier.push = fake(enabled);
    sent = [];
  };

  it('báo vắng: tạo thông báo + gửi data-only đúng 1 lần dù worker chạy 2 lần', async () => {
    use();
    const s = await student('Trần Bảo Châu');
    const ev = event([change(s, 'unexcused', null)]);
    await notifier.handle(ev);
    await notifier.handle(ev);
    const n = await rows(
      `select id, type, urgency, payload from notifications where payload->>'studentId' = $1`,
      [s],
    );
    expect(n).toHaveLength(1);
    expect(n[0].type).toBe('student_absent');
    expect(n[0].payload.studentName).toBe('Trần Bảo Châu');
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.data).sort()).toEqual([
      'notificationId',
      'type',
    ]);
    expect(JSON.stringify(sent)).not.toContain('Châu');
    const d = await rows(
      `select status from notification_deliveries where notification_id = $1`,
      [n[0].id],
    );
    expect(d).toEqual([{ status: 'sent' }]);
  });

  it('chỉ vắng không phép mới báo: vắng có phép, có mặt, đi muộn không tạo thông báo', async () => {
    use();
    const s = await student('Lê Minh');
    await notifier.handle(
      event([
        change(s, 'excused', null),
        change(s, 'present', null),
        change(s, 'late', 'present'),
      ]),
    );
    expect(
      await rows(
        `select 1 from notifications where payload->>'studentId' = $1`,
        [s],
      ),
    ).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('đính chính trong 10 phút gửi tới người đã nhận báo vắng; sau 10 phút thì không', async () => {
    use();
    const s1 = await student('Em Một');
    const s2 = await student('Em Hai');
    await notifier.handle(
      event([change(s1, 'unexcused', null), change(s2, 'unexcused', null)]),
    );
    sent = [];
    await notifier.handle(event([change(s1, 'present', 'unexcused')]));
    await notifier.handle(
      event(
        [change(s2, 'late', 'unexcused')],
        new Date(Date.now() + 11 * 60_000),
      ),
    );
    const c = await rows(
      `select payload->>'studentId' as s from notifications where type = 'student_absent_correction'`,
    );
    expect(c).toEqual([{ s: s1 }]);
    expect(sent).toHaveLength(1);
  });

  it('lỗi FCM tạm → ném để thử lại, lần sau gửi được và không gửi trùng', async () => {
    use();
    const s = await student('Em Ba');
    const ev = event([change(s, 'unexcused', null)]);
    behaviour = (m) =>
      m.map(() => ({
        ok: false,
        error: 'messaging/unavailable',
        invalidToken: false,
      }));
    await expect(notifier.handle(ev)).rejects.toThrow();
    expect(
      await rows(
        `select d.status from notification_deliveries d join notifications n on n.id = d.notification_id where n.payload->>'studentId' = $1`,
        [s],
      ),
    ).toEqual([{ status: 'failed' }]);
    behaviour = ok;
    await notifier.handle(ev);
    await notifier.handle(ev);
    const d = await rows(
      `select d.status from notification_deliveries d join notifications n on n.id = d.notification_id where n.payload->>'studentId' = $1`,
      [s],
    );
    expect(d).toEqual([{ status: 'sent' }]);
  });

  it('token hỏng bị xóa khỏi devices, không ném lỗi', async () => {
    use();
    const bad = `fcm-bad-${randomUUID()}`;
    await t.worker.query(
      `insert into devices (id, user_id, token, platform) values ($1, $2, $3, 'ios')`,
      [randomUUID(), parent.userId, bad],
    );
    const s = await student('Em Bốn');
    behaviour = (m) =>
      m.map((x) =>
        x.token === bad
          ? {
              ok: false,
              error: 'messaging/registration-token-not-registered',
              invalidToken: true,
            }
          : { ok: true, messageId: 'm' },
      );
    await notifier.handle(event([change(s, 'unexcused', null)]));
    expect(
      await rows(`select 1 from devices where token = $1`, [bad]),
    ).toHaveLength(0);
    expect(
      await rows(`select 1 from devices where token = $1`, [token]),
    ).toHaveLength(1);
    behaviour = ok;
  });

  it('thiếu cấu hình FCM: thông báo vẫn vào hộp thư, không gửi, không ném lỗi', async () => {
    use(false);
    const s = await student('Em Năm');
    await notifier.handle(event([change(s, 'unexcused', null)]));
    expect(sent).toHaveLength(0);
    expect(
      await rows(
        `select d.error from notification_deliveries d join notifications n on n.id = d.notification_id where n.payload->>'studentId' = $1`,
        [s],
      ),
    ).toEqual([{ error: 'push_disabled' }]);
  });

  it('GET /notifications: chỉ của chính user; chéo user thấy rỗng; phân trang con trỏ', async () => {
    const mine = await get(parent, '?limit=2');
    expect(mine.statusCode).toBe(200);
    const body = mine.json();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();
    expect(body.unreadCount).toBeGreaterThanOrEqual(2);
    const page2 = (
      await get(parent, `?limit=50&cursor=${body.nextCursor}`)
    ).json();
    const ids = new Set(
      [...body.items, ...page2.items].map((i: { id: string }) => i.id),
    );
    expect(ids.size).toBe(body.items.length + page2.items.length);

    const theirs = (await get(other)).json();
    expect(theirs).toMatchObject({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });

  it('GET /notifications: con trỏ sai → 422 VALIDATION_FAILED', async () => {
    const res = await get(parent, '?cursor=khong-hop-le');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('POST /notifications/read: chéo user bị bỏ qua, id trùng tính một lần, không phân biệt id lạ', async () => {
    const list = (await get(parent)).json();
    const id = list.items[0].id as string;
    const intruder = await read(other, [id]);
    expect(intruder.statusCode).toBe(200);
    expect(intruder.json().updated).toBe(0);
    expect(
      (await rows(`select read_at from notifications where id = $1`, [id]))[0]
        .read_at,
    ).toBeNull();

    const mine = await read(parent, [id, id, randomUUID()]);
    expect(mine.json().updated).toBe(1);
    expect(mine.json().unreadCount).toBe(list.unreadCount - 1);
    expect((await read(parent, [id])).json().updated).toBe(0);
  });
});
