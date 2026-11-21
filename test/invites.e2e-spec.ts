import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { startTestApp, type TestApp } from './support/app.js';
import { seedTenant, type SeededTenant } from './support/seed.js';

type Teacher = SeededTenant & { token: string };
type Parent = { userId: string; token: string };

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const TERMS = '2026-12-01';

// S4-BE-02..05: phụ huynh, lời mời (tạo/thu hồi/gửi lại), xem trước/nhận/đổi mã, đồng ý điều khoản.
describe('lời mời phụ huynh và đồng ý điều khoản', () => {
  let t: TestApp;
  let redis: Redis;
  let A: Teacher;
  let B: Teacher;

  const call = (
    token: string | null,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
    key: string | null = randomUUID(),
    ip?: string,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      remoteAddress: ip,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === 'GET' || !key ? {} : { 'idempotency-key': key }),
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
  const mkParent = async (
    name = 'Phụ huynh',
    consent = true,
  ): Promise<Parent> => {
    const userId = randomUUID();
    await t.worker.query(
      `insert into users (id, email, display_name) values ($1, $2, $3)`,
      [userId, `${userId}@example.com`, name],
    );
    const token = await t.tokenFor(userId);
    if (consent) {
      const r = await call(token, 'POST', '/consents', {
        role: 'parent',
        termsVersion: TERMS,
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    return { userId, token };
  };
  let dobSeq = 0;
  const student = async (who: Teacher, guardians = 2) => {
    dobSeq++;
    const res = await call(who.token, 'POST', '/students', {
      fullName: 'Nguyễn Minh Anh',
      // Ngày sinh khác nhau để không dính cảnh báo trùng hồ sơ.
      dob: `20${String(10 + (dobSeq % 10)).padStart(2, '0')}-${String(1 + (Math.floor(dobSeq / 10) % 12)).padStart(2, '0')}-${String(1 + (Math.floor(dobSeq / 120) % 28)).padStart(2, '0')}`,
      guardians: [
        { fullName: 'Nguyễn Văn Hải', relation: 'father', phone: '0912345678' },
        { fullName: 'Trần Thị Mai', relation: 'mother' },
      ].slice(0, guardians),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; guardians: { id: string }[] };
  };
  const invite = async (
    who: Teacher,
    studentId: string,
    guardianId: string,
  ) => {
    const res = await call(
      who.token,
      'POST',
      `/students/${studentId}/invites`,
      {
        guardianId,
      },
    );
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as {
      id: string;
      token: string;
      shortCode: string;
      url: string;
      status: string;
    };
  };
  const row = async (id: string) =>
    (await t.worker.query(`select * from invites where id = $1`, [id])).rows[0];
  const accept = (p: Parent, token: string, key?: string | null, ip?: string) =>
    call(p.token, 'POST', '/invites/accept', { token }, key, ip);
  const redeem = (p: Parent, code: string, key?: string | null, ip?: string) =>
    call(p.token, 'POST', '/invites/redeem-code', { code }, key, ip);
  /** Thân lỗi bỏ requestId để so sánh các nhánh lỗi với nhau. */
  const shape = (r: { statusCode: number; body: string }) => {
    const { requestId: _r, ...rest } = r.statusCode ? JSON.parse(r.body) : {};
    return { status: r.statusCode, body: rest, len: r.body.length };
  };

  beforeAll(async () => {
    t = await startTestApp();
    redis = new Redis(t.redis.getConnectionUrl());
    A = await mkTeacher('Cô Lan');
    B = await mkTeacher('Thầy Bình');
  }, 180_000);
  afterAll(async () => {
    redis?.disconnect();
    await t?.stop();
  });

  describe('tạo lời mời (S4-BE-03)', () => {
    it('chỉ lưu băm: token_hash = SHA-256, mã ngắn lưu HMAC (không phải băm trơn), hạn 7 ngày / 48 giờ; GET không trả bí mật', async () => {
      const s = await student(A);
      const inv = await invite(A, s.id, s.guardians[0]!.id);
      expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(inv.shortCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(inv.url).toMatch(/^https:\/\/dayhoc\.app\/i#t=/);
      expect(inv.url.endsWith(inv.token)).toBe(true);
      const r = await row(inv.id);
      expect(r.token_hash).toBe(sha256(inv.token));
      expect(r.short_code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.short_code_hash).not.toBe(sha256(inv.shortCode));
      expect(JSON.stringify(r)).not.toContain(inv.token);
      expect(JSON.stringify(r)).not.toContain(inv.shortCode);
      const days = (r.expires_at - r.created_at) / 86_400_000;
      const hours = (r.short_code_expires_at - r.created_at) / 3_600_000;
      expect(days).toBeCloseTo(7, 1);
      expect(hours).toBeCloseTo(48, 1);

      const list = await call(A.token, 'GET', `/students/${s.id}/invites`);
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(inv.token);
      expect(list.body).not.toContain(inv.shortCode);
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0]).toMatchObject({
        id: inv.id,
        status: 'pending',
        acceptedBy: null,
      });
    });

    it('phản hồi idempotency chứa token được mã hóa (không có nguyên văn), phát lại trong 10 phút, quá hạn → 409', async () => {
      const s = await student(A, 1);
      const key = randomUUID();
      const body = { guardianId: s.guardians[0]!.id };
      const first = await call(
        A.token,
        'POST',
        `/students/${s.id}/invites`,
        body,
        key,
      );
      const again = await call(
        A.token,
        'POST',
        `/students/${s.id}/invites`,
        body,
        key,
      );
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual(first.json());
      const stored = await t.worker.query(
        `select response_body, created_at from idempotency_keys where key = $1`,
        [key],
      );
      const text = JSON.stringify(stored.rows[0].response_body);
      expect(text).not.toContain(first.json().token);
      expect(text).not.toContain(first.json().shortCode);
      expect(Object.keys(stored.rows[0].response_body)).toEqual(['enc']);
      // Khóa idempotency khác không thấy phản hồi của khóa này.
      await t.worker.query(
        `update idempotency_keys set created_at = now() - interval '11 minutes' where key = $1`,
        [key],
      );
      const late = await call(
        A.token,
        'POST',
        `/students/${s.id}/invites`,
        body,
        key,
      );
      expect(late.statusCode).toBe(409);
      expect(late.json().code).toBe('CONFLICT_STALE');
    });

    it('guardianId không thuộc học viên / học viên tenant khác / không tồn tại → cùng 404; không có lời mời nào được tạo', async () => {
      const s1 = await student(A, 1);
      const s2 = await student(A, 1);
      const sB = await student(B, 1);
      const cases: [Teacher, string, string][] = [
        [A, s1.id, s2.guardians[0]!.id], // phụ huynh của học viên khác, cùng tenant
        [A, s1.id, sB.guardians[0]!.id], // phụ huynh tenant khác
        [A, sB.id, sB.guardians[0]!.id], // học viên tenant khác
        [B, s1.id, s1.guardians[0]!.id], // B gọi trên học viên của A
        [A, s1.id, randomUUID()],
      ];
      for (const [who, sid, gid] of cases) {
        const res = await call(who.token, 'POST', `/students/${sid}/invites`, {
          guardianId: gid,
        });
        expect(res.statusCode, `${sid}/${gid}`).toBe(404);
      }
      const n = await t.worker.query(
        `select count(*)::int n from invites where student_id = any($1)`,
        [[s1.id, s2.id, sB.id]],
      );
      expect(n.rows[0].n).toBe(0);
      expect(
        (await call(B.token, 'GET', `/students/${s1.id}/invites`)).statusCode,
      ).toBe(404);
    });

    it('mời lại vô hiệu lời mời cũ ngay trong cùng giao dịch: chỉ một lời mời pending, link cũ chết', async () => {
      const s = await student(A, 1);
      const g = s.guardians[0]!.id;
      const old = await invite(A, s.id, g);
      const fresh = await invite(A, s.id, g);
      expect((await row(old.id)).status).toBe('revoked');
      expect((await row(fresh.id)).status).toBe('pending');
      const pend = await t.worker.query(
        `select count(*)::int n from invites where guardian_id = $1 and status = 'pending'`,
        [g],
      );
      expect(pend.rows[0].n).toBe(1);
      const prev = await call(null, 'POST', '/invites/preview', {
        token: old.token,
      });
      expect(prev.statusCode).toBe(410);
      expect(
        (await call(null, 'POST', '/invites/preview', { token: fresh.token }))
          .statusCode,
      ).toBe(200);
      // Hai lần tạo song song: vẫn đúng một pending.
      const [x, y] = await Promise.all([
        call(A.token, 'POST', `/students/${s.id}/invites`, { guardianId: g }),
        call(A.token, 'POST', `/students/${s.id}/invites`, { guardianId: g }),
      ]);
      expect([x.statusCode, y.statusCode]).toEqual([201, 201]);
      const pend2 = await t.worker.query(
        `select count(*)::int n from invites where guardian_id = $1 and status = 'pending'`,
        [g],
      );
      expect(pend2.rows[0].n).toBe(1);
    });

    it('thu hồi: idempotent, tenant khác 404, đã dùng 409; gửi lại cấp link mới; PATCH bỏ phụ huynh thu hồi lời mời còn hiệu lực', async () => {
      const s = await student(A, 2);
      const inv = await invite(A, s.id, s.guardians[0]!.id);
      expect(
        (await call(B.token, 'POST', `/invites/${inv.id}/revoke`)).statusCode,
      ).toBe(404);
      expect(
        (await call(B.token, 'POST', `/invites/${inv.id}/resend`)).statusCode,
      ).toBe(404);
      const r1 = await call(A.token, 'POST', `/invites/${inv.id}/revoke`);
      expect(r1.statusCode).toBe(200);
      expect(r1.json().status).toBe('revoked');
      const r2 = await call(A.token, 'POST', `/invites/${inv.id}/revoke`);
      expect(r2.json().id).toBe(inv.id);
      expect(
        (await call(null, 'POST', '/invites/preview', { token: inv.token }))
          .statusCode,
      ).toBe(410);
      const re = await call(A.token, 'POST', `/invites/${inv.id}/resend`);
      expect(re.statusCode).toBe(201);
      expect(re.json().token).not.toBe(inv.token);
      expect(
        (
          await call(null, 'POST', '/invites/preview', {
            token: re.json().token,
          })
        ).statusCode,
      ).toBe(200);

      // Gỡ phụ huynh khỏi học viên → lời mời pending của người đó bị thu hồi.
      const keep = s.guardians[1]!.id;
      const patch = await call(A.token, 'PATCH', `/students/${s.id}`, {
        guardians: [{ id: keep, fullName: 'Trần Thị Mai', relation: 'mother' }],
      });
      expect(patch.statusCode, patch.body).toBe(200);
      expect((await row(re.json().id)).status).toBe('revoked');
      expect(
        (
          await call(null, 'POST', '/invites/preview', {
            token: re.json().token,
          })
        ).statusCode,
      ).toBe(410);
    });
  });

  describe('trạng thái mời trong roster và Student (S4-BE-02)', () => {
    it('chưa mời → đã mời → hết hạn → đã kích hoạt; gộp theo học viên activated > invited > expired > not_invited', async () => {
      const cls = await call(A.token, 'POST', '/classes', {
        name: 'Toán 9A',
        subject: 'Toán',
        grade: 9,
        mode: 'online',
        startDate: '2026-12-14',
      });
      expect(cls.statusCode, cls.body).toBe(201);
      const s = await student(A, 2);
      const enr = await call(
        A.token,
        'POST',
        `/classes/${cls.json().id}/enrollments`,
        {
          studentId: s.id,
          joinedOn: '2026-12-14',
        },
      );
      expect(enr.statusCode, enr.body).toBeLessThan(300);
      const roster = async () =>
        (await call(A.token, 'GET', `/classes/${cls.json().id}/roster`)).json()
          .items[0] as {
          inviteStatus: string;
          guardians: {
            id: string;
            inviteStatus: string;
            latestInvite: { id: string } | null;
          }[];
        };
      let r = await roster();
      expect(r.inviteStatus).toBe('not_invited');
      expect(r.guardians.map((g) => g.latestInvite)).toEqual([null, null]);

      const [g1, g2] = s.guardians.map((g) => g.id) as [string, string];
      const i1 = await invite(A, s.id, g1);
      r = await roster();
      expect(r.inviteStatus).toBe('invited');
      expect(r.guardians[0]).toMatchObject({
        inviteStatus: 'invited',
        latestInvite: { id: i1.id },
      });

      await t.worker.query(
        `update invites set expires_at = now() - interval '1 minute' where id = $1`,
        [i1.id],
      );
      r = await roster();
      expect(r.inviteStatus).toBe('expired');
      expect(r.guardians[0]!.inviteStatus).toBe('expired');
      const stu = await call(
        A.token,
        'GET',
        `/students?classId=${cls.json().id}`,
      );
      expect(stu.json().items[0].guardians[0]).toMatchObject({
        inviteStatus: 'expired',
        latestInvite: { id: i1.id },
      });

      const i2 = await invite(A, s.id, g2);
      expect((await roster()).inviteStatus).toBe('invited'); // invited > expired

      const p = await mkParent();
      expect((await accept(p, i2.token)).statusCode).toBe(200);
      r = await roster();
      expect(r.inviteStatus).toBe('activated'); // activated > expired/invited
      expect(r.guardians[1]!.inviteStatus).toBe('activated');
      const list = await call(A.token, 'GET', `/students/${s.id}/invites`);
      expect(
        list
          .json()
          .items.map((i: { status: string }) => i.status)
          .sort(),
      ).toEqual(['expired', 'used']);
      expect(
        list.json().items.find((i: { status: string }) => i.status === 'used')
          .acceptedBy.displayName,
      ).toBe('Phụ huynh');
    });
  });

  describe('xem trước và nhận lời mời (S4-BE-04)', () => {
    it('preview công khai chỉ trả tên giáo viên, tên gọi của con và hạn; header no-store + no-referrer', async () => {
      const s = await student(A, 1);
      const inv = await invite(A, s.id, s.guardians[0]!.id);
      const res = await call(null, 'POST', '/invites/preview', {
        token: inv.token,
      });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual([
        'expiresAt',
        'studentGivenName',
        'teacherName',
      ]);
      expect(res.json()).toMatchObject({
        teacherName: 'Cô Lan',
        studentGivenName: 'Anh',
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('mọi nhánh lỗi cùng 410, cùng thân, cùng độ dài; header an toàn cả khi lỗi', async () => {
      const s = await student(A, 2);
      const used = await invite(A, s.id, s.guardians[0]!.id);
      const revoked = await invite(A, s.id, s.guardians[1]!.id);
      await call(A.token, 'POST', `/invites/${revoked.id}/revoke`);
      const expired = await (async () => {
        const e = await student(A, 1);
        const i = await invite(A, e.id, e.guardians[0]!.id);
        await t.worker.query(
          `update invites set expires_at = now() - interval '1 second' where id = $1`,
          [i.id],
        );
        return i;
      })();
      const p = await mkParent();
      expect((await accept(p, used.token)).statusCode).toBe(200);

      const tokens = [
        used.token,
        revoked.token,
        expired.token,
        'x'.repeat(43),
        'a',
        'x'.repeat(128),
      ];
      const previews = await Promise.all(
        tokens.map((token) =>
          call(null, 'POST', '/invites/preview', { token }),
        ),
      );
      // Ngưỡng 5 lần sai/user: chia các lần nhận sai cho hai tài khoản.
      const p2 = await mkParent();
      const accepts = await Promise.all(
        tokens.map((token, i) => accept(i < 3 ? p : p2, token)),
      );
      for (const r of [...previews, ...accepts]) {
        expect(shape(r).status).toBe(410);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['referrer-policy']).toBe('no-referrer');
      }
      const shapes = new Set(
        [...previews, ...accepts].map((r) => JSON.stringify(shape(r))),
      );
      expect(shapes.size).toBe(1);
      expect(JSON.parse([...shapes][0]!).body).toEqual({
        code: 'INVITE_INVALID',
        message: 'Lời mời không dùng được. Hãy nhắn giáo viên xin link mới.',
      });
    });

    it('thứ tự: chưa đăng nhập 401 → chưa đồng ý 403 (không lộ token đúng/sai) → tra token', async () => {
      const s = await student(A, 1);
      const inv = await invite(A, s.id, s.guardians[0]!.id);
      expect(
        (await call(null, 'POST', '/invites/accept', { token: inv.token }))
          .statusCode,
      ).toBe(401);
      const p = await mkParent('Chưa đồng ý', false);
      const good = await accept(p, inv.token);
      const bad = await accept(p, 'sai-token');
      for (const r of [good, bad]) {
        expect(r.statusCode).toBe(403);
        expect(r.json()).toMatchObject({
          code: 'CONSENT_REQUIRED',
          details: { termsVersion: TERMS },
        });
      }
      expect((await row(inv.id)).status).toBe('pending');
      // Sau khi đồng ý thì nhận được.
      await call(p.token, 'POST', '/consents', {
        role: 'parent',
        termsVersion: TERMS,
      });
      expect((await accept(p, inv.token)).statusCode).toBe(200);
    });

    it('nhận thành công: membership Phụ huynh, guardians.user_id, lời mời used, audit không chứa token; gộp vào tài khoản có sẵn', async () => {
      const s = await student(A, 2);
      const [i1, i2] = [
        await invite(A, s.id, s.guardians[0]!.id),
        await invite(A, s.id, s.guardians[1]!.id),
      ];
      const p = await mkParent('Chị Mai');
      // Đã có vai trò Phụ huynh trước đó (tự thêm qua /me/roles): không tạo membership thứ hai.
      const role = await call(p.token, 'POST', '/me/roles', { role: 'parent' });
      expect(role.statusCode).toBe(201);
      const ok = await accept(p, i1.token);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({
        membershipId: role.json().membershipId,
        studentId: s.id,
        studentName: 'Nguyễn Minh Anh',
      });
      const g = await t.worker.query(
        `select user_id from guardians where id = $1`,
        [s.guardians[0]!.id],
      );
      expect(g.rows[0].user_id).toBe(p.userId);
      const m = await t.worker.query(
        `select count(*)::int n from memberships where user_id = $1 and role = 'parent'`,
        [p.userId],
      );
      expect(m.rows[0].n).toBe(1);
      const r = await row(i1.id);
      expect(r).toMatchObject({
        status: 'used',
        used_by: p.userId,
        accepted_by_name: 'Chị Mai',
      });
      const audit = await t.worker.query(
        `select after_data::text a, actor_user_id from audit_logs where entity = 'invite' and entity_id = $1`,
        [i1.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_user_id).toBe(p.userId);
      expect(audit.rows[0].a).not.toContain(i1.token);
      expect(audit.rows[0].a).not.toContain(i1.shortCode);
      // Phụ huynh thứ hai cùng một tài khoản vẫn một membership.
      const ok2 = await accept(p, i2.token);
      expect(ok2.statusCode).toBe(200);
      expect(ok2.json().membershipId).toBe(role.json().membershipId);
      // Đã kích hoạt: tạo/gửi lại lời mời cho phụ huynh đó → 409.
      expect(
        (
          await call(A.token, 'POST', `/students/${s.id}/invites`, {
            guardianId: s.guardians[0]!.id,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await call(A.token, 'POST', `/invites/${i1.id}/resend`)).statusCode,
      ).toBe(409);
      expect(
        (await call(A.token, 'POST', `/invites/${i1.id}/revoke`)).statusCode,
      ).toBe(409);
      // Token đã dùng: phát lại cùng khóa idempotency trả đúng kết quả cũ; token đã dùng với khóa mới → 410.
      expect((await accept(p, i1.token)).statusCode).toBe(410);
    });

    it('accept/redeem-code: dòng idempotency không chứa tên trẻ, token hay mã dạng rõ; requestHash không phải SHA-256 trơn', async () => {
      const s = await student(A, 2);
      const i = await invite(A, s.id, s.guardians[0]!.id);
      const p = await mkParent('Chị Lan');
      const ok = await accept(p, i.token);
      expect(ok.statusCode, ok.body).toBe(200);
      const rows = await t.worker.query(
        `select response_body::text b, request_hash h from idempotency_keys where user_id = $1`,
        [p.userId],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const r of rows.rows) {
        expect(r.b).not.toContain('Nguyễn Minh Anh');
        expect(r.b).not.toContain(s.id);
        expect(r.h).not.toBe(
          createHash('sha256')
            .update(JSON.stringify({ body: { token: i.token } }))
            .digest('hex'),
        );
      }
      const i2 = await invite(A, s.id, s.guardians[1]!.id);
      const q = await mkParent('Chị Hoa');
      const rc = await redeem(q, i2.shortCode);
      expect(rc.statusCode, rc.body).toBe(200);
      const r2 = await t.worker.query(
        `select response_body::text b, request_hash h from idempotency_keys where user_id = $1`,
        [q.userId],
      );
      expect(r2.rows.length).toBeGreaterThan(0);
      for (const r of r2.rows) {
        expect(r.b).not.toContain('Nguyễn Minh Anh');
        expect(r.h).not.toBe(
          createHash('sha256').update(i2.shortCode).digest('hex'),
        );
      }
    });

    it('hai người nhận song song cùng token: đúng một người thắng, người kia 410', async () => {
      const s = await student(A, 1);
      const inv = await invite(A, s.id, s.guardians[0]!.id);
      const [p1, p2] = [await mkParent(), await mkParent()];
      const res = await Promise.all([
        accept(p1, inv.token),
        accept(p2, inv.token),
      ]);
      expect(res.map((r) => r.statusCode).sort()).toEqual([200, 410]);
      const g = await t.worker.query(
        `select user_id from guardians where id = $1`,
        [s.guardians[0]!.id],
      );
      expect([p1.userId, p2.userId]).toContain(g.rows[0].user_id);
    });

    it('mã ngắn: không phân biệt hoa/thường, hết hạn sau 48 giờ nhưng link còn sống 7 ngày; đổi mã không dùng được lại', async () => {
      const s = await student(A, 2);
      const a = await invite(A, s.id, s.guardians[0]!.id);
      const b = await invite(A, s.id, s.guardians[1]!.id);
      await t.worker.query(
        `update invites set short_code_expires_at = now() - interval '1 minute' where id = $1`,
        [b.id],
      );
      const p = await mkParent();
      expect((await redeem(p, b.shortCode)).statusCode).toBe(410);
      expect((await accept(p, b.token)).statusCode).toBe(200); // link vẫn dùng được
      const ok = await redeem(p, a.shortCode.toLowerCase().replace(/1/g, 'l'));
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().studentId).toBe(s.id);
      expect((await redeem(await mkParent(), a.shortCode)).statusCode).toBe(
        410,
      );
      // Sai định dạng → 422, không phải 410.
      expect(
        (await call(p.token, 'POST', '/invites/redeem-code', { code: 'abc' }))
          .statusCode,
      ).toBe(422);
    });
  });

  describe('khóa nhập sai (US-0.12 AC5)', () => {
    const failures = (key: string) =>
      redis.get(key).then((v) => Number(v ?? 0));

    it('5 lần sai trong 15 phút → 429 INVITE_CODE_LOCKED + Retry-After, kể cả mã đúng; có audit khóa không chứa mã', async () => {
      const s = await student(A, 1);
      const inv = await invite(A, s.id, s.guardians[0]!.id);
      const p = await mkParent();
      const ip = '198.51.100.10';
      for (let i = 0; i < 5; i++) {
        expect((await redeem(p, `ZZZZZZZ${i}`, undefined, ip)).statusCode).toBe(
          410,
        );
      }
      const locked = await redeem(p, inv.shortCode, undefined, ip);
      expect(locked.statusCode).toBe(429);
      expect(locked.json().code).toBe('INVITE_CODE_LOCKED');
      expect(locked.json().details.retryAfterSec).toBeGreaterThan(0);
      expect((await accept(p, inv.token)).statusCode).toBe(429);
      expect((await row(inv.id)).status).toBe('pending');
      const audit = await t.worker.query(
        `select after_data::text a from audit_logs where entity = 'invite_lock' and actor_user_id = $1`,
        [p.userId],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows[0].a).not.toContain(inv.shortCode);
      // Người khác (IP khác) vẫn dùng được: khóa theo user không chặn người lạ.
      const q = await mkParent();
      expect(
        (await redeem(q, inv.shortCode, undefined, '198.51.100.99')).statusCode,
      ).toBe(200);
    });

    it('phát lại 410 với cùng Idempotency-Key và lỗi 422 không tính vào bộ đếm; khóa mới thì tính', async () => {
      const p = await mkParent();
      const ip = '198.51.100.20';
      const counter = `inv:f:accept:u:${p.userId}`;
      const key = randomUUID();
      for (let i = 0; i < 3; i++) {
        expect((await redeem(p, 'ZZZZZZZZ', key, ip)).statusCode).toBe(410);
      }
      expect(await failures(counter)).toBe(1);
      expect(
        (
          await call(
            p.token,
            'POST',
            '/invites/redeem-code',
            { code: 'ngắn' },
            undefined,
            ip,
          )
        ).statusCode,
      ).toBe(422);
      expect(await failures(counter)).toBe(1);
      expect((await redeem(p, 'ZZZZZZZZ', randomUUID(), ip)).statusCode).toBe(
        410,
      );
      expect(await failures(counter)).toBe(2);
    });

    it('request song song không vượt ngưỡng: 12 lần sai cùng lúc → đúng 5 lần 410, 7 lần 429', async () => {
      const p = await mkParent();
      const res = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          redeem(p, `ZZZZZZY${i % 10}`, undefined, `198.51.100.${30 + i}`),
        ),
      );
      const by = (n: number) => res.filter((r) => r.statusCode === n).length;
      expect([by(410), by(429)]).toEqual([5, 7]);
      expect(
        await failures(`inv:f:accept:u:${p.userId}`),
      ).toBeGreaterThanOrEqual(5);
    });

    it('bộ đếm toàn cục chỉ áp cho đổi mã ngắn: token sai không chạm bộ đếm toàn cục, mã sai thì có', async () => {
      const p = await mkParent();
      const before = await failures('inv:f:accept:g');
      await accept(p, 'x'.repeat(43), undefined, '198.51.100.60');
      expect(await failures('inv:f:accept:g')).toBe(before);
      await redeem(p, 'ZZZZZZZX', undefined, '198.51.100.61');
      expect(await failures('inv:f:accept:g')).toBe(before + 1);
    });

    it('membership Phụ huynh đã revoked: nhận lời mời trả 410 đồng nhất, lời mời không bị đốt, không khôi phục', async () => {
      const s = await student(A, 1);
      const inv = await invite(A, s.id, s.guardians[0]!.id);
      const p = await mkParent();
      const role = await call(p.token, 'POST', '/me/roles', { role: 'parent' });
      expect(role.statusCode).toBe(201);
      await t.worker.query(
        `update memberships set status = 'revoked' where id = $1`,
        [role.json().membershipId],
      );
      const r = await accept(p, inv.token, undefined, '198.51.100.70');
      expect(r.statusCode).toBe(410);
      expect((await row(inv.id)).status).toBe('pending');
      const m = await t.worker.query(
        `select status from memberships where id = $1`,
        [role.json().membershipId],
      );
      expect(m.rows[0].status).toBe('revoked');
    });

    it('cùng user nhận hai lời mời song song: không 500, cả hai thành công với một membership', async () => {
      const s = await student(A, 2);
      const [i1, i2] = [
        await invite(A, s.id, s.guardians[0]!.id),
        await invite(A, s.id, s.guardians[1]!.id),
      ];
      const p = await mkParent();
      const res = await Promise.all([accept(p, i1.token), accept(p, i2.token)]);
      expect(res.map((r) => r.statusCode)).toEqual([200, 200]);
      const m = await t.worker.query(
        `select count(*)::int n from memberships where user_id = $1 and role = 'parent'`,
        [p.userId],
      );
      expect(m.rows[0].n).toBe(1);
    });

    it('IP gộp theo /64: nhiều địa chỉ cùng dải IPv6 chung một bộ đếm', async () => {
      const p = await mkParent();
      await redeem(p, 'ZZZZZZZZ', undefined, '2001:db8:aaaa:1::1');
      await redeem(p, 'ZZZZZZZZ', undefined, '2001:db8:aaaa:1:ffff::9');
      expect(await failures('inv:f:accept:ip:2001:db8:aaaa:1::/64')).toBe(2);
    });
  });

  describe('đồng ý điều khoản (S4-BE-05)', () => {
    it('ghi thêm dòng; trùng (user, role, phiên bản) trong 60 giây trả dòng cũ; ip_hash là HMAC, acceptedAt theo giờ server', async () => {
      const p = await mkParent('PH', false);
      const body = { role: 'parent', termsVersion: TERMS };
      const ip = '203.0.113.5';
      const r1 = await call(p.token, 'POST', '/consents', body, undefined, ip);
      expect(r1.statusCode).toBe(201);
      const r2 = await call(p.token, 'POST', '/consents', body);
      expect(r2.statusCode).toBe(201);
      expect(r2.json().id).toBe(r1.json().id);
      const rows = await t.worker.query(
        `select * from consents where user_id = $1`,
        [p.userId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows.rows[0].ip_hash).not.toContain(ip);
      expect(rows.rows[0].ip_hash).not.toBe(sha256(ip));
      expect(
        Math.abs(rows.rows[0].accepted_at.getTime() - Date.now()),
      ).toBeLessThan(60_000);
      // Quá 60 giây: thêm dòng mới (người dùng khác chỉ có dòng cũ 2 phút trước).
      const q = await mkParent('PH2', false);
      await t.worker.query(
        `insert into consents (id, user_id, role, terms_version, accepted_at) values (gen_random_uuid(), $1, 'parent', $2, now() - interval '2 minutes')`,
        [q.userId, TERMS],
      );
      const r3 = await call(q.token, 'POST', '/consents', body);
      expect(r3.statusCode).toBe(201);
      expect(
        (
          await t.worker.query(
            `select count(*)::int n from consents where user_id = $1`,
            [q.userId],
          )
        ).rows[0].n,
      ).toBe(2);
    });

    it('phiên bản khác hiện hành → 409; vai trò lạ → 422; status phản ánh đúng bản hiện hành', async () => {
      const p = await mkParent('PH', false);
      expect(
        (
          await call(p.token, 'POST', '/consents', {
            role: 'parent',
            termsVersion: '1999-01-01',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call(p.token, 'POST', '/consents', {
            role: 'teacher',
            termsVersion: TERMS,
          })
        ).statusCode,
      ).toBe(422);
      const before = await call(p.token, 'GET', '/consents/status?role=parent');
      expect(before.json()).toEqual({
        role: 'parent',
        currentTermsVersion: TERMS,
        accepted: false,
        acceptedAt: null,
        acceptedTermsVersion: null,
      });
      await call(p.token, 'POST', '/consents', {
        role: 'parent',
        termsVersion: TERMS,
      });
      const after = (
        await call(p.token, 'GET', '/consents/status?role=parent')
      ).json();
      expect(after).toMatchObject({
        accepted: true,
        acceptedTermsVersion: TERMS,
      });
      // Chỉ đọc dữ liệu của chính mình.
      const other = await mkParent('Khác', false);
      expect(
        (await call(other.token, 'GET', '/consents/status?role=parent')).json()
          .accepted,
      ).toBe(false);
    });
  });
});
