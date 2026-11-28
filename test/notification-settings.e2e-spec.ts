import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { TxService } from '@teachhub/db';
import type { PushMessage } from '@teachhub/infra';
import * as schema from '../libs/db/src/schema/index.js';
import { formatInZone } from '../libs/modules/schedule/domain/zoned-time.js';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };

const TZ = 'Asia/Ho_Chi_Minh';
/** `HH:MM` giờ VN của thời điểm cách bây giờ `h` giờ. */
const hhmm = (h: number) =>
  formatInZone(new Date(Date.now() + h * 3_600_000), TZ).slice(11, 16);

// US-6.2 (bật/tắt thông báo theo lớp) và US-6.5 (giờ yên lặng): API + notifier + job notify.deferred-push.
describe('thông báo: bật/tắt theo lớp và giờ yên lặng', () => {
  let t: TestApp;
  let A: Who;
  let B: Who;
  let sent: PushMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let absence: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let subscription: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deferredJob: any;

  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    who: { token: string },
    method: 'GET' | 'PATCH' | 'PUT',
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(method === 'PATCH' ? { 'idempotency-key': randomUUID() } : {}),
      },
    });
  const setQuiet = (who: SeededTenant, start: string, end: string) =>
    q(
      `update tenants set settings = jsonb_set(settings, '{quietHours}', $2::jsonb) where id = $1`,
      [who.tenantId, JSON.stringify({ start, end })],
    );

  beforeAll(async () => {
    t = await startTestApp();
    const mk = async () => {
      const s = await seedTenant(t.worker);
      return { ...s, token: await t.tokenFor(s.userId) };
    };
    A = await mk();
    B = await mk();
    sent = [];
    const push = {
      enabled: true,
      send: (m: PushMessage[]) => {
        sent.push(...m);
        return Promise.resolve(
          m.map(() => ({ ok: true as const, messageId: 'm1' })),
        );
      },
    };
    // import động: @teachhub/core kiểm env khi nạp, mà env chỉ có sau startTestApp.
    const { AbsenceNotifier } =
      await import('../libs/modules/notifications/application/absence-notifier.service.js');
    const { SubscriptionNotifier } =
      await import('../libs/modules/notifications/application/subscription-notifier.service.js');
    const { DeferredPushJob } =
      await import('../libs/modules/notifications/application/deferred-push.job.js');
    const tx = new TxService(
      drizzle(t.worker, { schema, casing: 'snake_case' }),
    );
    const delivery = new AbsenceNotifier(tx, push as never);
    absence = delivery;
    subscription = new SubscriptionNotifier(tx, delivery);
    deferredJob = new DeferredPushJob(
      tx,
      { track: (_name: string, fn: () => Promise<number>) => fn() } as never,
      delivery,
      { send: () => Promise.resolve() } as never,
    );
  }, 180_000);

  afterAll(async () => t?.stop());

  const ALL_ON = {
    absence: true,
    grade: true,
    homework: true,
    invoice: true,
    dunning: true,
    schedule: true,
  };

  /** Học viên vắng không phép ở lớp có `settings`, phụ huynh có thiết bị; trả sự kiện điểm danh cho AbsenceNotifier. */
  const absenceWorld = async (settings: object) => {
    const classId = randomUUID();
    const sessionId = randomUUID();
    const studentId = randomUUID();
    const parent = randomUUID();
    await q(
      `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date, notification_settings)
       values ($1, $2, $3, 'Toán 9A', 'Toán', 9, 'online', '2026-01-01', $4::jsonb)`,
      [classId, A.tenantId, A.branchId, JSON.stringify(settings)],
    );
    await q(
      `insert into sessions (id, tenant_id, class_id, session_date, starts_at, ends_at)
       values ($1, $2, $3, '2026-12-15', '2026-12-15T11:00:00Z', '2026-12-15T12:30:00Z')`,
      [sessionId, A.tenantId, classId],
    );
    await q(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Trần Bảo Châu')`,
      [studentId, A.tenantId],
    );
    await q(`insert into users (id, email) values ($1, $2)`, [
      parent,
      `${parent}@example.com`,
    ]);
    await q(
      `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
      [randomUUID(), parent],
    );
    await q(
      `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'PH', $4)`,
      [randomUUID(), A.tenantId, studentId, parent],
    );
    await q(
      `insert into devices (id, user_id, token, platform) values ($1, $2, $3, 'android')`,
      [randomUUID(), parent, `fcm-${randomUUID()}`],
    );
    const attendanceId = randomUUID();
    await q(
      `insert into attendance (id, tenant_id, session_id, student_id, status, client_updated_at)
       values ($1, $2, $3, $4, 'unexcused', now())`,
      [attendanceId, A.tenantId, sessionId, studentId],
    );
    return {
      parent,
      job: {
        eventId: randomUUID(),
        tenantId: A.tenantId,
        payload: {
          sessionId,
          recordedAt: new Date().toISOString(),
          changes: [
            {
              studentId,
              attendanceId,
              status: 'unexcused',
              previousStatus: null,
            },
          ],
        },
      },
    };
  };

  describe('US-6.2: notificationSettings của lớp', () => {
    const mkClass = async (who: SeededTenant) => {
      const id = randomUUID();
      await q(
        `insert into classes (id, tenant_id, branch_id, name, subject, grade, mode, start_date)
         values ($1, $2, $3, 'Toán 9A', 'Toán', 9, 'online', '2026-01-01')`,
        [id, who.tenantId, who.branchId],
      );
      return id;
    };

    it('lớp mới bật cả 6 loại; PATCH một phần gộp khóa, khóa lạ bị từ chối, chéo tenant 404', async () => {
      const id = await mkClass(A);
      const g = await call(A, 'GET', `/classes/${id}`);
      expect(g.json().notificationSettings).toEqual(ALL_ON);

      const p1 = await call(A, 'PATCH', `/classes/${id}`, {
        notificationSettings: { absence: false },
      });
      expect(p1.statusCode, p1.body).toBe(200);
      expect(p1.json().notificationSettings).toEqual({
        ...ALL_ON,
        absence: false,
      });
      const p2 = await call(A, 'PATCH', `/classes/${id}`, {
        notificationSettings: { invoice: false },
      });
      expect(p2.json().notificationSettings).toEqual({
        ...ALL_ON,
        absence: false,
        invoice: false,
      });
      // Không gửi `notificationSettings` thì giữ nguyên; danh sách cũng trả trường này.
      const p3 = await call(A, 'PATCH', `/classes/${id}`, { name: 'Toán 9B' });
      expect(p3.json().notificationSettings.absence).toBe(false);
      const list = await call(A, 'GET', '/classes');
      expect(
        list.json().items.find((c: { id: string }) => c.id === id)
          .notificationSettings.invoice,
      ).toBe(false);

      for (const bad of [
        { notificationSettings: { sms: false } },
        { notificationSettings: { absence: 'no' } },
      ])
        expect((await call(A, 'PATCH', `/classes/${id}`, bad)).statusCode).toBe(
          422,
        );

      expect(
        (
          await call(B, 'PATCH', `/classes/${id}`, {
            notificationSettings: { absence: true },
          })
        ).statusCode,
      ).toBe(404);
    });

    it('AC3: lớp tắt `absence` → báo vắng không tạo dòng thông báo, không push, không delivery; bật lại thì gửi', async () => {
      sent = [];
      const off = await absenceWorld({ ...ALL_ON, absence: false });
      await absence.handle(off.job);
      expect(
        await q(`select 1 from notifications where recipient_user_id = $1`, [
          off.parent,
        ]),
      ).toHaveLength(0);
      expect(sent).toHaveLength(0);

      const on = await absenceWorld(ALL_ON);
      await absence.handle(on.job);
      const rows = await q(
        `select n.type, n.send_after = n.created_at as immediate from notifications n where n.recipient_user_id = $1`,
        [on.parent],
      );
      expect(rows).toEqual([{ type: 'student_absent', immediate: true }]);
      expect(sent).toHaveLength(1);
    });

    it('khóa `invoice`/`dunning` tắt chỉ chặn đúng loại của nó (lớp khác loại vẫn gửi)', async () => {
      sent = [];
      const w = await absenceWorld({
        ...ALL_ON,
        invoice: false,
        dunning: false,
      });
      await absence.handle(w.job);
      expect(sent).toHaveLength(1);
    });
  });

  describe('US-6.5: giờ yên lặng', () => {
    it('quiet-hours: chỉ chủ tenant; tenant B không thấy khung của A', async () => {
      // seedTenant đặt khung 1 phút cho e2e ổn định; xóa để thấy mặc định.
      await q(
        `update tenants set settings = settings - 'quietHours' where id = $1`,
        [A.tenantId],
      );
      const def = await call(A, 'GET', '/tenant/settings/quiet-hours');
      expect(def.statusCode, def.body).toBe(200);
      expect(def.json()).toEqual({ start: '21:30', end: '07:00' });

      const put = await call(A, 'PUT', '/tenant/settings/quiet-hours', {
        start: '22:00',
        end: '06:30',
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toEqual({ start: '22:00', end: '06:30' });
      expect(
        (await call(A, 'GET', '/tenant/settings/quiet-hours')).json(),
      ).toEqual({ start: '22:00', end: '06:30' });
      // Lưu không phá các khóa khác của settings, và có dòng nhật ký.
      expect(
        (
          await q(
            `select count(*)::int as n from audit_logs where tenant_id = $1 and entity = 'quiet_hours'`,
            [A.tenantId],
          )
        )[0].n,
      ).toBe(1);

      const bGet = await call(B, 'GET', '/tenant/settings/quiet-hours');
      expect(bGet.json()).not.toEqual({ start: '22:00', end: '06:30' });

      const teacher = {
        token: await t.tokenFor(
          await seedMember(t.worker, A.tenantId, 'teacher'),
        ),
      };
      for (const [method, body] of [
        ['GET', undefined],
        ['PUT', { start: '22:00', end: '06:30' }],
      ] as const)
        expect(
          (await call(teacher, method, '/tenant/settings/quiet-hours', body))
            .statusCode,
        ).toBe(403);
    });

    it('PUT: sai dạng, ngoài 00:00–23:59, start trùng end, thiếu trường → 422', async () => {
      for (const bad of [
        { start: '24:00', end: '07:00' },
        { start: '21:60', end: '07:00' },
        { start: '9:00', end: '07:00' },
        { start: '08:00', end: '08:00' },
        { start: '21:30' },
      ]) {
        const r = await call(A, 'PUT', '/tenant/settings/quiet-hours', bad);
        expect(r.statusCode, JSON.stringify(bad)).toBe(422);
      }
      // Khung không qua nửa đêm và khung sát ranh giới hợp lệ.
      for (const ok of [
        { start: '12:00', end: '13:00' },
        { start: '00:00', end: '23:59' },
      ])
        expect(
          (await call(A, 'PUT', '/tenant/settings/quiet-hours', ok)).statusCode,
        ).toBe(200);
    });

    const activate = (tenant: SeededTenant) =>
      subscription.handleActivated({
        eventId: randomUUID(),
        tenantId: tenant.tenantId,
        payload: {
          source: 'bank_transfer',
          currentPeriodEnd: '2099-01-01T00:00:00Z',
        },
      });
    const ownerNotifications = (tenant: SeededTenant) =>
      q(
        `select id, send_after > created_at as deferred, send_after > now() as future
         from notifications where recipient_user_id = $1`,
        [tenant.userId],
      );
    const deliveries = (id: string) =>
      q(
        `select channel, status from notification_deliveries where notification_id = $1`,
        [id],
      );

    it('tin không khẩn trong giờ yên lặng: send_after ở tương lai, chưa push; job notify.deferred-push gửi khi tới giờ, chạy lại không gửi trùng', async () => {
      await setQuiet(A, hhmm(-1), hhmm(1)); // bây giờ nằm giữa khung
      await q(
        `insert into devices (id, user_id, token, platform) values ($1, $2, $3, 'android')`,
        [randomUUID(), A.userId, `fcm-${randomUUID()}`],
      );
      sent = [];
      await activate(A);

      const [n] = await ownerNotifications(A);
      expect(n).toMatchObject({ deferred: true, future: true });
      expect(sent).toHaveLength(0);
      expect(await deliveries(n.id)).toHaveLength(0);

      // Chưa tới giờ: job không động tới.
      expect(await deferredJob.run()).toBe(0);
      expect(sent).toHaveLength(0);

      // Tới giờ (lùi send_after về quá khứ nhưng vẫn sau created_at).
      await q(
        `update notifications set created_at = now() - interval '2 hours', send_after = now() - interval '1 minute' where id = $1`,
        [n.id],
      );
      expect(await deferredJob.run()).toBeGreaterThanOrEqual(1);
      expect(sent).toHaveLength(1);
      expect(await deliveries(n.id)).toEqual([
        { channel: 'push', status: 'sent' },
      ]);

      await deferredJob.run();
      expect(sent).toHaveLength(1);
    });

    it('ngoài giờ yên lặng: gửi ngay, send_after = lúc tạo, job không đụng tới', async () => {
      await setQuiet(B, hhmm(2), hhmm(3));
      await q(
        `insert into devices (id, user_id, token, platform) values ($1, $2, $3, 'android')`,
        [randomUUID(), B.userId, `fcm-${randomUUID()}`],
      );
      sent = [];
      await activate(B);
      const [n] = await ownerNotifications(B);
      expect(n).toMatchObject({ deferred: false, future: false });
      expect(sent).toHaveLength(1);
      expect(await deliveries(n.id)).toEqual([
        { channel: 'push', status: 'sent' },
      ]);
      await deferredJob.run();
      expect(sent).toHaveLength(1);
    });

    it('tin khẩn (báo vắng) trong giờ yên lặng vẫn gửi ngay', async () => {
      await setQuiet(A, hhmm(-1), hhmm(1));
      const w = await absenceWorld(ALL_ON);
      sent = [];
      await absence.handle(w.job);
      expect(sent).toHaveLength(1);
      expect(
        await q(
          `select send_after = created_at as immediate from notifications where recipient_user_id = $1`,
          [w.parent],
        ),
      ).toEqual([{ immediate: true }]);
    });
  });
});
