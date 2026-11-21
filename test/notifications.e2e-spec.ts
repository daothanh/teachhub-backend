import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis as IORedis } from 'ioredis';
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
  /** Đặt dòng điểm danh hiện tại của học viên rồi trả phần tử thay đổi của sự kiện outbox. */
  const change = async (
    studentId: string,
    status: string,
    previousStatus: string | null,
  ): Promise<Change> => {
    const attendanceId = randomUUID();
    await t.worker.query(
      `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (session_id, student_id) do update set status = excluded.status returning id`,
      [attendanceId, A.tenantId, sessionId, studentId, status],
    );
    const id = (
      await t.worker.query(
        `select id from attendance where session_id = $1 and student_id = $2`,
        [sessionId, studentId],
      )
    ).rows[0].id as string;
    return { studentId, attendanceId: id, status, previousStatus };
  };
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
    const ev = event([await change(s, 'unexcused', null)]);
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
        await change(s, 'excused', null),
        await change(s, 'present', null),
        await change(s, 'late', 'present'),
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
      event([
        await change(s1, 'unexcused', null),
        await change(s2, 'unexcused', null),
      ]),
    );
    sent = [];
    await notifier.handle(event([await change(s1, 'present', 'unexcused')]));
    await notifier.handle(
      event(
        [await change(s2, 'late', 'unexcused')],
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
    const ev = event([await change(s, 'unexcused', null)]);
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
    await notifier.handle(event([await change(s, 'unexcused', null)]));
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
    await notifier.handle(event([await change(s, 'unexcused', null)]));
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

  const deliveryStatus = async (studentId: string) =>
    (
      await rows(
        `select d.status from notification_deliveries d join notifications n on n.id = d.notification_id where n.payload->>'studentId' = $1`,
        [studentId],
      )
    ).map((r) => r.status);

  it('M2: FCM ném lỗi → delivery failed, job ném lại; thử lại nhận được; claim dở chưa quá hạn không bị coi là xong', async () => {
    use();
    const s = await student('Em Sáu');
    const ev = event([await change(s, 'unexcused', null)]);
    notifier.push = {
      enabled: true,
      send: () => Promise.reject(new Error('mạng đứt')),
    };
    await expect(notifier.handle(ev)).rejects.toThrow();
    expect(await deliveryStatus(s)).toEqual(['failed']);
    use();
    await notifier.handle(ev);
    expect(await deliveryStatus(s)).toEqual(['sent']);
    expect(sent).toHaveLength(1);

    const s2 = await student('Em Bảy');
    const ev2 = event([await change(s2, 'unexcused', null)]);
    use(false);
    await notifier.handle(ev2); // tạo thông báo + delivery failed(push_disabled)
    await t.worker.query(
      `update notification_deliveries set status = 'queued', created_at = now() where notification_id in
         (select id from notifications where payload->>'studentId' = $1)`,
      [s2],
    );
    use();
    await expect(notifier.handle(ev2)).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('M3: đính chính xử lý trước, báo vắng tới sau → không gửi báo vắng', async () => {
    use();
    const s = await student('Em Tám');
    const absent = event([await change(s, 'unexcused', null)]);
    const fix = event([await change(s, 'present', 'unexcused')]); // dòng hiện tại đã là present
    await notifier.handle(fix);
    await notifier.handle(absent);
    expect(
      await rows(
        `select 1 from notifications where payload->>'studentId' = $1`,
        [s],
      ),
    ).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('S8: cửa sổ đính chính tính từ giờ ghi của sự kiện vắng, không từ created_at', async () => {
    use();
    const [old, recent] = [await student('Em Chín'), await student('Em Mười')];
    const at = (min: number) => new Date(Date.now() - min * 60_000);
    await notifier.handle(
      event([await change(old, 'unexcused', null)], at(15)),
    );
    await notifier.handle(
      event([await change(recent, 'unexcused', null)], at(5)),
    );
    await notifier.handle(event([await change(old, 'present', 'unexcused')]));
    await notifier.handle(
      event([await change(recent, 'present', 'unexcused')]),
    );
    const c = await rows(
      `select payload->>'studentId' as s from notifications where type = 'student_absent_correction' and payload->>'studentId' = any($1)`,
      [[old, recent]],
    );
    expect(c).toEqual([{ s: recent }]);
  });

  it('M5: có index tra báo vắng theo (tenant, buổi, học viên)', async () => {
    expect(
      await rows(
        `select 1 from pg_indexes where indexname = 'notifications_absence_lookup_idx'`,
      ),
    ).toHaveLength(1);
  });

  it('M1: queue urgent dựng qua OutboxModule thật (attempts + backoff thật), BullMQ chạy lại sau lỗi tạm: delivery sent đúng 1 lần', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ConfigModule } = await import('@nestjs/config');
    const { getQueueToken } = await import('@nestjs/bullmq');
    const { OutboxModule } =
      await import('../apps/worker/src/outbox/outbox.module.js');
    const { OutboxRelayService } =
      await import('../apps/worker/src/outbox/outbox-relay.service.js');
    const { OutboxCleanupService } =
      await import('../apps/worker/src/outbox/outbox-cleanup.service.js');
    const { UrgentProcessor } =
      await import('../apps/worker/src/notify/urgent.processor.js');

    use();
    const s = await student('Em Mười Một');
    const ev = event([await change(s, 'unexcused', null)]);
    let calls = 0;
    notifier.push = {
      enabled: true,
      send: (m: PushMessage[]) => {
        calls++;
        sent.push(...m);
        return Promise.resolve(
          calls === 1
            ? m.map(() => ({
                ok: false as const,
                error: 'messaging/unavailable',
                invalidToken: false,
              }))
            : ok(m),
        );
      },
    };
    // Relay/cleanup không cần ở đây (chỉ lấy hàng đợi và tuỳ chọn job do module thật cấu hình).
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ REDIS_URL: t.redis.getConnectionUrl() })],
        }),
        OutboxModule,
      ],
    })
      .overrideProvider(OutboxRelayService)
      .useValue({})
      .overrideProvider(OutboxCleanupService)
      .useValue({})
      .compile();
    const queue = mod.get<Queue>(getQueueToken('urgent'));
    const connection = new IORedis(t.redis.getConnectionUrl(), {
      maxRetriesPerRequest: null,
    });
    const proc = new UrgentProcessor(notifier, notifier.tx);
    const worker = new Worker('urgent', (job) => proc.process(job), {
      connection,
    });
    try {
      const job = await queue.add('attendance_recorded', ev, {
        jobId: ev.eventId,
      });
      expect(job.opts.attempts).toBeGreaterThan(1);
      expect(job.opts.backoff).toMatchObject({ type: 'exponential' });
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline && (await deliveryStatus(s))[0] !== 'sent')
        await new Promise((r) => setTimeout(r, 200));
      expect(await deliveryStatus(s)).toEqual(['sent']);
      expect(calls).toBe(2);
      expect(
        await rows(
          `select 1 from notifications where payload->>'studentId' = $1`,
          [s],
        ),
      ).toHaveLength(1);
    } finally {
      await worker.close();
      await mod.close();
      connection.disconnect();
    }
  }, 60_000);

  it('đính chính: FCM sập lúc báo vắng (delivery chưa sent) → cô sửa trong 10 phút cũng không có đính chính', async () => {
    use();
    const s = await student('Em Mười Hai');
    behaviour = (m) =>
      m.map(() => ({
        ok: false,
        error: 'messaging/unavailable',
        invalidToken: false,
      }));
    await expect(
      notifier.handle(event([await change(s, 'unexcused', null)])),
    ).rejects.toThrow();
    behaviour = ok;
    await notifier.handle(event([await change(s, 'present', 'unexcused')]));
    expect(
      await rows(
        `select 1 from notifications where type = 'student_absent_correction' and payload->>'studentId' = $1`,
        [s],
      ),
    ).toHaveLength(0);
  });

  it('đính chính: dòng báo vắng cũ có event_at NULL dùng created_at dự phòng', async () => {
    use();
    const s = await student('Em Mười Ba');
    await notifier.handle(event([await change(s, 'unexcused', null)]));
    await t.worker.query(
      `update notifications set event_at = null where type = 'student_absent' and payload->>'studentId' = $1`,
      [s],
    );
    await notifier.handle(event([await change(s, 'present', 'unexcused')]));
    expect(
      await rows(
        `select 1 from notifications where type = 'student_absent_correction' and payload->>'studentId' = $1`,
        [s],
      ),
    ).toHaveLength(1);
  });

  it('job hết lượt thử: log error và đánh dấu outbox failed_at; lỗi giữa chừng thì không', async () => {
    const { UrgentProcessor } =
      await import('../apps/worker/src/notify/urgent.processor.js');
    const proc = new UrgentProcessor(notifier, notifier.tx);
    const id = randomUUID();
    await t.worker.query(
      `insert into outbox_events (id, tenant_id, type, payload, dispatched_at) values ($1, $2, 'attendance_recorded', '{}', now())`,
      [id, A.tenantId],
    );
    const job = (made: number) =>
      ({
        name: 'attendance_recorded',
        data: { eventId: id },
        attemptsMade: made,
        opts: { attempts: 3 },
      }) as never;
    await proc.onFailed(job(2), new Error('x'));
    const state = async () =>
      (
        await rows(
          `select failed_at, last_error from outbox_events where id = $1`,
          [id],
        )
      )[0];
    expect((await state()).failed_at).toBeNull();
    await proc.onFailed(job(3), new Error('x'));
    const after = await state();
    expect(after.failed_at).not.toBeNull();
    expect(after.last_error).toContain('consumer_exhausted');
  });

  it('S3: con trỏ phải đúng dạng chặt, không chỉ "có |"', async () => {
    const enc = (v: string) => Buffer.from(v).toString('base64url');
    const id = randomUUID();
    for (const bad of [
      `2026-1-1|${id}`,
      `2026-12-15T11:00:00Z|${id}`,
      `2026-12-15T11:00:00.000000Z|${id.toUpperCase()}`,
      `2026-12-15T11:00:00.000000Z|${id}|x`,
      '',
    ])
      expect((await get(parent, `?cursor=${enc(bad)}`)).statusCode).toBe(422);
    // base64url không chuẩn hoá (thêm dấu '=') cũng bị từ chối
    expect(
      (
        await get(
          parent,
          `?cursor=${enc(`2026-12-15T11:00:00.000000Z|${id}`)}=`,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (await get(parent, `?cursor=${enc(`2026-12-15T11:00:00.000000Z|${id}`)}`))
        .statusCode,
    ).toBe(200);
  });
});
