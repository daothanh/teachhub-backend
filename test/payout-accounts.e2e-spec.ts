import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { startTestApp, type TestApp } from './support/app.js';
import { seedMember, seedTenant, type SeededTenant } from './support/seed.js';

type Who = SeededTenant & { token: string };
type OtpService = InstanceType<
  typeof import('../libs/modules/auth/otp/otp.service.js').OtpService
>;

// S5-BE-02 [money] [tenant-isolation]: CRUD tài khoản nhận tiền (OTP, tối đa 5, tài khoản chính, RLS).
describe('[money][tenant-isolation] payout accounts API', () => {
  let t: TestApp;
  let otp: OtpService;
  let redis: Redis;
  let A: Who;
  let B: Who;

  const mk = async (): Promise<Who> => {
    const s = await seedTenant(t.worker);
    return { ...s, token: await t.tokenFor(s.userId) };
  };
  const code = async (
    who: Who,
    purpose: 'payout_account' | 'login' = 'payout_account',
  ) => {
    const email = `${who.userId}@example.com`;
    // bỏ giới hạn 60 giây giữa hai lần gửi và 5 lần/giờ
    await redis.del(
      `otp:hour:${createHash('sha256').update(email).digest('hex')}`,
      `otp:cooldown${purpose === 'login' ? '' : `:${purpose}`}:${createHash('sha256').update(email).digest('hex')}`,
    );
    return otp.issue(email, purpose);
  };
  const call = (
    who: { token: string },
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      },
    });
  const add = async (who: Who, over: object = {}) =>
    call(who, 'POST', '/payout-accounts', {
      bankBin: '970436',
      accountNo: '0123456789',
      accountName: 'NGUYEN VAN A',
      otpCode: await code(who),
      ...over,
    });
  const rows = async (tenantId: string) =>
    (
      await t.worker.query(
        `select id, account_no, is_primary from payout_accounts where tenant_id = $1 order by created_at, id`,
        [tenantId],
      )
    ).rows as { id: string; account_no: string; is_primary: boolean }[];

  beforeAll(async () => {
    t = await startTestApp();
    const { OtpService: Otp } =
      await import('../libs/modules/auth/otp/otp.service.js');
    otp = t.app.get(Otp);
    redis = new Redis(t.redis.getConnectionUrl());
  }, 180_000);
  afterAll(async () => {
    redis?.disconnect();
    await t?.stop();
  });

  it('AC-6: tài khoản đầu tự là chính, số tài khoản được che, không lộ số đầy đủ; danh sách chính đứng đầu', async () => {
    const who = await mk();
    expect((await call(who, 'GET', '/payout-accounts')).json()).toEqual({
      items: [],
    });
    const r1 = await add(who);
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json()).toMatchObject({
      bankBin: '970436',
      accountNoMasked: '******6789',
      accountName: 'NGUYEN VAN A',
      isPrimary: true,
    });
    expect(r1.body).not.toContain('0123456789');
    // tài khoản thứ hai: isPrimary mặc định false, kể cả khi gửi false cho tài khoản đầu
    const r2 = await add(who, { accountNo: '9876543210' });
    expect(r2.json().isPrimary).toBe(false);
    const list = (await call(who, 'GET', '/payout-accounts')).json().items;
    expect(list.map((a: { id: string }) => a.id)).toEqual([
      r1.json().id,
      r2.json().id,
    ]);
    // đặt tài khoản sau làm chính, nó lên đầu
    const r3 = await add(who, { accountNo: '1112223334', isPrimary: true });
    expect(r3.json().isPrimary).toBe(true);
    const after = (await call(who, 'GET', '/payout-accounts')).json().items;
    expect(after[0].id).toBe(r3.json().id);
    expect(
      after.filter((a: { isPrimary: boolean }) => a.isPrimary),
    ).toHaveLength(1);
  });

  it('AC-6: OTP bắt buộc và đúng purpose: thiếu → 422, sai → 401 OTP_INVALID, mã login không dùng được', async () => {
    const who = await mk();
    const body = {
      bankBin: '970436',
      accountNo: '0123456789',
      accountName: 'A',
    };
    expect((await call(who, 'POST', '/payout-accounts', body)).statusCode).toBe(
      422,
    );
    const wrong = await call(who, 'POST', '/payout-accounts', {
      ...body,
      otpCode: '000000',
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('OTP_INVALID');
    const loginCode = await code(who, 'login');
    const r = await call(who, 'POST', '/payout-accounts', {
      ...body,
      otpCode: loginCode,
    });
    expect(r.statusCode).toBe(401);
    expect(await rows(who.tenantId)).toHaveLength(0);
  });

  it('AC-6: định dạng bankBin (6 số) và accountNo (6 đến 19 số) → 422', async () => {
    const who = await mk();
    for (const over of [
      { bankBin: '97043' },
      { bankBin: '97043a' },
      { accountNo: '12345' },
      { accountNo: '1'.repeat(20) },
      { accountName: ' ' },
    ]) {
      const r = await add(who, over);
      expect(r.statusCode, JSON.stringify(over)).toBe(422);
    }
    expect(await rows(who.tenantId)).toHaveLength(0);
  });

  it('AC-6: tối đa 5 tài khoản mỗi tenant → 422; OTP chưa bị tiêu khi bị chặn', async () => {
    const who = await mk();
    for (let i = 0; i < 5; i++) {
      const r = await add(who, { accountNo: `10000000${i}0` });
      expect(r.statusCode, r.body).toBe(201);
    }
    const spare = await code(who);
    const sixth = await call(who, 'POST', '/payout-accounts', {
      bankBin: '970436',
      accountNo: '9999999999',
      accountName: 'A',
      otpCode: spare,
    });
    expect(sixth.statusCode).toBe(422);
    expect(await rows(who.tenantId)).toHaveLength(5);
    // mã còn dùng được sau khi xóa bớt một tài khoản
    const first = (await rows(who.tenantId))[1]!;
    expect(
      (await call(who, 'DELETE', `/payout-accounts/${first.id}`)).statusCode,
    ).toBe(204);
    const again = await call(who, 'POST', '/payout-accounts', {
      bankBin: '970436',
      accountNo: '9999999999',
      accountName: 'A',
      otpCode: spare,
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('AC-6: PATCH đổi tên không cần OTP; đổi số cần OTP; isPrimary=true chuyển cờ; không đổi hóa đơn', async () => {
    const who = await mk();
    const a = (await add(who)).json();
    const b = (await add(who, { accountNo: '9876543210' })).json();
    const rename = await call(who, 'PATCH', `/payout-accounts/${a.id}`, {
      accountName: 'NGUYEN VAN B',
    });
    expect(rename.statusCode, rename.body).toBe(200);
    expect(rename.json().accountName).toBe('NGUYEN VAN B');
    const noOtp = await call(who, 'PATCH', `/payout-accounts/${a.id}`, {
      accountNo: '5555555555',
    });
    expect(noOtp.statusCode).toBe(422);
    const badOtp = await call(who, 'PATCH', `/payout-accounts/${a.id}`, {
      accountNo: '5555555555',
      otpCode: '000000',
    });
    expect(badOtp.statusCode).toBe(401);
    const ok = await call(who, 'PATCH', `/payout-accounts/${a.id}`, {
      accountNo: '5555555555',
      otpCode: await code(who),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().accountNoMasked).toBe('******5555');
    expect(
      (await rows(who.tenantId)).find((r) => r.id === a.id)!.account_no,
    ).toBe('5555555555');
    const prim = await call(who, 'PATCH', `/payout-accounts/${b.id}`, {
      isPrimary: true,
    });
    expect(prim.json().isPrimary).toBe(true);
    const rs = await rows(who.tenantId);
    expect(rs.find((r) => r.id === a.id)!.is_primary).toBe(false);
    expect(rs.filter((r) => r.is_primary)).toHaveLength(1);
    // isPrimary: false không hợp lệ theo hợp đồng
    expect(
      (
        await call(who, 'PATCH', `/payout-accounts/${b.id}`, {
          isPrimary: false,
        })
      ).statusCode,
    ).toBe(422);
  });

  it('AC-6: xóa tài khoản chính → tài khoản tạo sớm nhất còn lại thành chính; xóa cuối cùng được; gọi lại → 404', async () => {
    const who = await mk();
    const a = (await add(who)).json();
    const b = (await add(who, { accountNo: '9876543210' })).json();
    const c = (await add(who, { accountNo: '1112223334' })).json();
    expect(
      (await call(who, 'DELETE', `/payout-accounts/${a.id}`)).statusCode,
    ).toBe(204);
    const rs = await rows(who.tenantId);
    expect(rs.map((r) => [r.id, r.is_primary])).toEqual([
      [b.id, true],
      [c.id, false],
    ]);
    expect(
      (await call(who, 'DELETE', `/payout-accounts/${a.id}`)).statusCode,
    ).toBe(404);
    await call(who, 'DELETE', `/payout-accounts/${b.id}`);
    expect(
      (await call(who, 'DELETE', `/payout-accounts/${c.id}`)).statusCode,
    ).toBe(204);
    expect((await call(who, 'GET', '/payout-accounts')).json()).toEqual({
      items: [],
    });
  });

  it('cô lập tenant: B không đọc, sửa, xóa tài khoản của A (404, dữ liệu A không đổi)', async () => {
    A = await mk();
    B = await mk();
    const a = (await add(A)).json();
    await add(B, { accountNo: '7777777777' });
    const before = await rows(A.tenantId);
    const listB = (await call(B, 'GET', '/payout-accounts')).json().items;
    expect(listB.map((x: { id: string }) => x.id)).not.toContain(a.id);
    const patchB = await call(B, 'PATCH', `/payout-accounts/${a.id}`, {
      accountName: 'HACKER',
    });
    expect(patchB.statusCode).toBe(404);
    const patchB2 = await call(B, 'PATCH', `/payout-accounts/${a.id}`, {
      accountNo: '1231231234',
      otpCode: await code(B),
    });
    expect(patchB2.statusCode).toBe(404);
    expect(
      (await call(B, 'DELETE', `/payout-accounts/${a.id}`)).statusCode,
    ).toBe(404);
    expect(await rows(A.tenantId)).toEqual(before);
    // id client gửi trùng id của A → không ghi đè, không lộ
    const dup = await add(B, { id: a.id, accountNo: '8888888888' });
    expect(dup.statusCode).toBe(409);
    expect(await rows(A.tenantId)).toEqual(before);
  });

  it('vai trò: chỉ tenant_owner (teacher → 403 cả đọc lẫn ghi)', async () => {
    const who = await mk();
    const teacher = await seedMember(t.worker, who.tenantId, 'teacher');
    const tw = { token: await t.tokenFor(teacher) };
    expect((await call(tw, 'GET', '/payout-accounts')).statusCode).toBe(403);
    expect(
      (await call(tw, 'DELETE', `/payout-accounts/${randomUUID()}`)).statusCode,
    ).toBe(403);
  });
});
