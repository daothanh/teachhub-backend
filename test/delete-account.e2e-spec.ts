import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant } from './support/seed.js';

type OtpService = InstanceType<
  typeof import('../libs/modules/auth/otp/otp.service.js').OtpService
>;

// S4-BE-09: DELETE /me kèm OTP (US-0.9) và tách mã OTP theo purpose.
describe('xóa tài khoản: DELETE /v1/me', () => {
  let t: TestApp;
  let mailpit: StartedTestContainer;
  let otp: OtpService;
  let redis: Redis;
  /** Bỏ giới hạn 60 giây giữa hai lần gửi để test gửi mã liên tiếp. */
  const resetCooldown = (email: string) =>
    redis.del(
      `otp:cooldown:${createHash('sha256').update(email).digest('hex')}`,
    );

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const del = (
    token: string,
    code: string,
    key: string | null = randomUUID(),
  ) =>
    t.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      payload: { otp: code },
      headers: { ...bearer(token), ...(key ? { 'idempotency-key': key } : {}) },
    });
  const login = (email: string, code: string) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { method: 'email_otp', email, code },
    });
  const q = async (sql: string, params: unknown[]) =>
    (await t.worker.query(sql, params)).rows;
  const emailOf = async (userId: string) =>
    (await q(`select email from users where id = $1`, [userId]))[0]!
      .email as string;

  beforeAll(async () => {
    mailpit = await new GenericContainer('axllent/mailpit:v1.33.1')
      .withExposedPorts(1025, 8025)
      .start();
    process.env.SMTP_URL = `smtp://127.0.0.1:${mailpit.getMappedPort(1025)}`;
    t = await startTestApp();
    const { OtpService: Otp } =
      await import('../libs/modules/auth/otp/otp.service.js');
    otp = t.app.get(Otp);
    redis = new Redis(t.redis.getConnectionUrl());
  }, 180_000);
  afterAll(async () => {
    redis?.disconnect();
    await t?.stop();
    await mailpit?.stop();
  });

  it('mã đăng nhập không xóa được tài khoản và mã xóa không đăng nhập được; OTP sai → 401', async () => {
    const a = await seedTenant(t.worker);
    const email = await emailOf(a.userId);
    const token = await t.tokenFor(a.userId);

    const loginCode = await otp.issue(email, 'login');
    const wrongPurpose = await del(token, loginCode);
    expect([wrongPurpose.statusCode, wrongPurpose.json().code]).toEqual([
      401,
      'OTP_INVALID',
    ]);
    // Mã đăng nhập vẫn dùng được cho đăng nhập (lần xóa sai mục đích không tiêu mã).
    expect((await login(email, loginCode)).statusCode).toBe(200);

    const deleteCode = await otp.issue(email, 'delete_account');
    const asLogin = await login(email, deleteCode);
    expect([asLogin.statusCode, asLogin.json().code]).toEqual([
      401,
      'OTP_INVALID',
    ]);
    const bad = await del(token, deleteCode === '000000' ? '111111' : '000000');
    expect(bad.statusCode).toBe(401);
    expect(
      (
        await q(`select 1 from users where id = $1 and deleted_at is null`, [
          a.userId,
        ])
      ).length,
    ).toBe(1);
  });

  it('POST /auth/otp/send với purpose = delete_account gửi mã xóa tài khoản, dùng được cho DELETE /me', async () => {
    const a = await seedTenant(t.worker);
    const email = await emailOf(a.userId);
    const send = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/send',
      payload: { email, purpose: 'delete_account' },
    });
    expect(send.statusCode).toBe(204);
    const res = await fetch(
      `http://127.0.0.1:${mailpit.getMappedPort(8025)}/api/v1/messages`,
    );
    const { messages } = (await res.json()) as {
      messages: { To: { Address: string }[]; Subject: string }[];
    };
    const subject = messages.find((m) => m.To[0]?.Address === email)?.Subject;
    expect(subject).toMatch(/^\d{6} là mã xác nhận xóa tài khoản/);
    const done = await del(await t.tokenFor(a.userId), subject!.slice(0, 6));
    expect(done.statusCode, done.body).toBe(204);
  });

  it('thiếu Idempotency-Key hoặc OTP sai định dạng → 422', async () => {
    const a = await seedTenant(t.worker);
    const token = await t.tokenFor(a.userId);
    expect((await del(token, '123456', null)).statusCode).toBe(422);
    expect((await del(token, 'abc')).statusCode).toBe(422);
  });

  it('chủ không gian còn lớp hoạt động → 409, OTP chưa bị tiêu; lưu trữ lớp rồi xóa → 204, dữ liệu cá nhân mất, chứng từ và audit còn', async () => {
    const a = await seedTenant(t.worker);
    const email = await emailOf(a.userId);
    // Đăng nhập thật để có identity + refresh token.
    const session = (
      await login(email, await otp.issue(email, 'login'))
    ).json();
    expect(session.user.id).toBe(a.userId);
    const token = session.access_token as string;

    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/classes',
      payload: {
        name: 'Toán 9A',
        subject: 'Toán',
        grade: 9,
        mode: 'online',
        startDate: '2030-01-07',
      },
      headers: { ...bearer(token), 'idempotency-key': randomUUID() },
    });
    expect(res.statusCode, res.body).toBe(201);
    const cid = res.json().id as string;
    const student = randomUUID();
    await t.worker.query(
      `insert into students (id, tenant_id, full_name, dob, school, note) values ($1, $2, 'Nguyễn Văn Nam', '2012-05-05', 'THCS A', 'dị ứng')`,
      [student, a.tenantId],
    );
    const parent = randomUUID();
    await t.worker.query(`insert into users (id, email) values ($1, $2)`, [
      parent,
      `${parent}@example.com`,
    ]);
    await t.worker.query(
      `insert into guardians (id, tenant_id, student_id, full_name, phone, email, user_id) values ($1, $2, $3, 'Chị Lan', '0900000000', 'lan@example.com', $4)`,
      [randomUUID(), a.tenantId, student, parent],
    );
    await t.worker.query(
      `insert into devices (id, user_id, platform, token) values ($1, $2, 'ios', $3)`,
      [randomUUID(), a.userId, randomUUID()],
    );
    await t.worker.query(
      `insert into center_waitlist (id, user_id, center_name, teacher_count) values ($1, $2, 'Trung tâm X', 3)`,
      [randomUUID(), a.userId],
    );

    const code = await otp.issue(email, 'delete_account');
    const blocked = await del(token, code);
    expect([blocked.statusCode, blocked.json().code]).toEqual([
      409,
      'CONFLICT_STALE',
    ]);
    expect(blocked.json().details).toMatchObject({
      reason: 'TENANT_HAS_ACTIVE_CLASSES',
      activeClasses: 1,
    });
    expect(
      (
        await q(`select 1 from users where id = $1 and deleted_at is null`, [
          a.userId,
        ])
      ).length,
    ).toBe(1);

    await t.worker.query(
      `update classes set status = 'archived' where id = $1`,
      [cid],
    );
    const key = randomUUID();
    const ok = await del(token, code, key); // cùng mã: lần 409 không tiêu mã
    expect(ok.statusCode, ok.body).toBe(204);

    const [u] = await q(`select * from users where id = $1`, [a.userId]);
    expect(u).toMatchObject({ email: null, display_name: null });
    expect(u.deleted_at).not.toBeNull();
    for (const [table, col] of [
      ['refresh_tokens', 'user_id'],
      ['auth_identities', 'user_id'],
      ['memberships', 'user_id'],
      ['devices', 'user_id'],
      ['center_waitlist', 'user_id'],
    ]) {
      expect(
        (await q(`select 1 from ${table} where ${col} = $1`, [a.userId]))
          .length,
        table,
      ).toBe(0);
    }
    const [tenant] = await q(
      `select name, deleted_at from tenants where id = $1`,
      [a.tenantId],
    );
    expect(tenant.name).toBe('Không gian đã xóa');
    expect(tenant.deleted_at).not.toBeNull();
    const [st] = await q(
      `select full_name, dob, school, note from students where id = $1`,
      [student],
    );
    expect(st.full_name).toMatch(/^Học viên đã xóa #[0-9a-f]{4}$/);
    expect([st.dob, st.school, st.note]).toEqual([null, null, null]);
    const [g] = await q(
      `select full_name, phone, email, user_id from guardians where tenant_id = $1`,
      [a.tenantId],
    );
    expect(g).toEqual({
      full_name: 'Phụ huynh đã xóa',
      phone: null,
      email: null,
      user_id: null,
    });
    // audit_logs của tenant (cấp/thu hồi vai trò, lớp) được giữ.
    expect(
      Number(
        (
          await q(`select count(*) n from audit_logs where tenant_id = $1`, [
            a.tenantId,
          ])
        )[0]!.n,
      ),
    ).toBeGreaterThan(0);

    // Token cũ mất quyền chủ không gian; gửi lại cùng khóa → phát lại 204.
    const old = await t.app.inject({
      method: 'GET',
      url: '/v1/classes',
      headers: bearer(token),
    });
    expect(old.statusCode).toBe(403);
    const replay = await del(token, code, key);
    expect([replay.statusCode, replay.headers['idempotent-replayed']]).toEqual([
      204,
      'true',
    ]);
    // refresh token cũ không còn dùng được.
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: { refresh_token: session.refresh_token },
        })
      ).statusCode,
    ).toBe(401);

    // Đăng nhập lại bằng email cũ → tài khoản mới, không thấy dữ liệu cũ.
    await resetCooldown(email);
    const again = (await login(email, await otp.issue(email, 'login'))).json();
    expect(again.user.id).not.toBe(a.userId);
    const mine = await t.app.inject({
      method: 'GET',
      url: '/v1/me/memberships',
      headers: bearer(again.access_token),
    });
    expect(mine.json().items).toEqual([]);
    const classes = await t.app.inject({
      method: 'GET',
      url: '/v1/classes',
      headers: bearer(again.access_token),
    });
    expect(classes.statusCode).toBe(403);
  });

  it('phụ huynh xóa tài khoản: gỡ liên kết, thiết bị, thông báo; học viên và không gian của giáo viên không đổi', async () => {
    const a = await seedTenant(t.worker);
    const student = randomUUID();
    await t.worker.query(
      `insert into students (id, tenant_id, full_name) values ($1, $2, 'Trần Bo')`,
      [student, a.tenantId],
    );
    const parent = randomUUID();
    const email = `${parent}@example.com`;
    await t.worker.query(`insert into users (id, email) values ($1, $2)`, [
      parent,
      email,
    ]);
    const membership = randomUUID();
    await t.worker.query(
      `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
      [membership, parent],
    );
    await t.worker.query(
      `insert into guardians (id, tenant_id, student_id, full_name, user_id) values ($1, $2, $3, 'Anh Hùng', $4)`,
      [randomUUID(), a.tenantId, student, parent],
    );
    await t.worker.query(
      `insert into devices (id, user_id, platform, token) values ($1, $2, 'android', $3)`,
      [randomUUID(), parent, randomUUID()],
    );
    await t.worker.query(
      `insert into notifications (id, tenant_id, recipient_user_id, membership_id, type, payload, dedupe_key)
       values ($1, $2, $3, $4, 'student_absent', '{}', 'k1')`,
      [randomUUID(), a.tenantId, parent, membership],
    );

    const token = await t.tokenFor(parent);
    const res = await del(token, await otp.issue(email, 'delete_account'));
    expect(res.statusCode, res.body).toBe(204);

    expect(
      (
        await q(`select user_id from guardians where student_id = $1`, [
          student,
        ])
      )[0],
    ).toEqual({ user_id: null });
    for (const [table, col] of [
      ['devices', 'user_id'],
      ['notifications', 'recipient_user_id'],
      ['memberships', 'user_id'],
    ]) {
      expect(
        (await q(`select 1 from ${table} where ${col} = $1`, [parent])).length,
        table,
      ).toBe(0);
    }
    expect(
      (await q(`select full_name from students where id = $1`, [student]))[0],
    ).toEqual({ full_name: 'Trần Bo' });
    expect(
      (
        await q(`select deleted_at from tenants where id = $1`, [a.tenantId])
      )[0],
    ).toEqual({ deleted_at: null });
  });
});
