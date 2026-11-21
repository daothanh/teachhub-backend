// S1-FL-12: dữ liệu dùng chung cho QA, FL, WEB (Plan Mục 4, nguyên tắc 9) — tạo qua API thật, không tạo tay.
//
//   pnpm seed:dev            # tạo (chạy lại an toàn: user/không gian đã có thì dùng lại)
//   pnpm seed:dev --reset    # xóa dữ liệu seed rồi tạo lại
//
// Cần: api đang chạy (pnpm start:api), Mailpit (docker compose) để đọc mã OTP, WORKER_DATABASE_URL cho
// --reset và tên hiển thị. Chỉ chạy với API local/dev.
import pg from 'pg';

const API = process.env.SEED_API_URL ?? 'http://127.0.0.1:3000/v1';
const MAILPIT = process.env.SEED_MAILPIT_URL ?? 'http://127.0.0.1:8025';
const DB = process.env.WORKER_DATABASE_URL;

/** Tenant A/B (giáo viên), phụ huynh X/Y — tên hiển thị như thiết kế Sprint 1. */
const PERSONAS = [
  { key: 'A', email: 'gv.a@teachhub.test', name: 'Cô Lan', role: 'teacher' },
  { key: 'B', email: 'gv.b@teachhub.test', name: 'Thầy Nam', role: 'teacher' },
  { key: 'X', email: 'ph.x@teachhub.test', name: 'Chị Hoa', role: 'parent' },
  { key: 'Y', email: 'ph.y@teachhub.test', name: 'Anh Minh', role: 'parent' },
];

const host = new URL(API).hostname;
if (!['127.0.0.1', 'localhost'].includes(host) && !host.includes('.dev.')) {
  console.error(`Từ chối seed vào ${host}: chỉ local hoặc môi trường dev.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { body, token, idempotent } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotent ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

/** Mã OTP mới nhất gửi tới `email` (tiêu đề "<mã> là mã đăng nhập…"), chờ tối đa 10 giây. */
async function otpFromMailpit(email, after) {
  for (let i = 0; i < 20; i++) {
    const { messages } = await (
      await fetch(`${MAILPIT}/api/v1/messages`)
    ).json();
    const msg = messages.find(
      (m) => m.To[0]?.Address === email && new Date(m.Created) >= after,
    );
    const code = msg?.Subject.match(/^(\d{6}) /)?.[1];
    if (code) return code;
    await sleep(500);
  }
  throw new Error(
    `Không thấy email OTP cho ${email} trong Mailpit (${MAILPIT}).`,
  );
}

async function login(email) {
  for (;;) {
    const after = new Date(Date.now() - 1000);
    const sent = await call('POST', '/auth/otp/send', { body: { email } });
    if (sent.status === 429) {
      const wait = sent.json?.details?.retryAfterSec ?? 60;
      console.log(`  ${email}: chờ ${wait} giây (giới hạn gửi mã)…`);
      await sleep(wait * 1000);
      continue;
    }
    if (sent.status !== 204) throw new Error(`otp/send ${sent.status}`);
    const code = await otpFromMailpit(email, after);
    const res = await call('POST', '/auth/login', {
      body: { method: 'email_otp', email, code },
    });
    if (res.status !== 200) {
      throw new Error(
        `login ${email}: ${res.status} ${JSON.stringify(res.json)}`,
      );
    }
    return res.json;
  }
}

async function reset(db) {
  const emails = PERSONAS.map((p) => p.email);
  await db.query('begin');
  // Tenant do user seed tạo; bảng con không cascade theo tenant nên xóa trước.
  const tenants = `select id from tenants where created_by in (select id from users where email = any($1))`;
  for (const table of ['memberships', 'subscriptions', 'branches']) {
    await db.query(`delete from ${table} where tenant_id in (${tenants})`, [
      emails,
    ]);
  }
  await db.query(`delete from tenants where id in (${tenants})`, [emails]);
  const { rowCount } = await db.query(
    'delete from users where email = any($1)',
    [emails],
  );
  await db.query('commit');
  console.log(`Đã xóa ${rowCount} user seed và dữ liệu của họ.`);
}

const db = DB ? new pg.Client({ connectionString: DB }) : null;
await db?.connect();
try {
  if (process.argv.includes('--reset')) {
    if (!db) throw new Error('--reset cần WORKER_DATABASE_URL.');
    await reset(db);
  }
  const rows = [];
  for (const p of PERSONAS) {
    let s = await login(p.email);
    // Chưa có API sửa hồ sơ (US-0.2): đặt tên hiển thị trực tiếp để nhãn vai trò giống thiết kế.
    if (db && !s.user.displayName) {
      await db.query('update users set display_name = $1 where id = $2', [
        p.name,
        s.user.id,
      ]);
    }
    const res =
      p.role === 'teacher'
        ? await call('POST', '/workspaces', {
            body: {},
            token: s.access_token,
            idempotent: true,
          })
        : await call('POST', '/me/roles', {
            body: { role: 'parent' },
            token: s.access_token,
            idempotent: true,
          });
    if (![200, 201].includes(res.status)) {
      throw new Error(`${p.email}: ${res.status} ${JSON.stringify(res.json)}`);
    }
    rows.push({
      actor: p.key,
      email: p.email,
      vaiTro: p.role === 'teacher' ? 'Giáo viên' : 'Phụ huynh',
      userId: s.user.id,
      tenantId: res.json.tenantId ?? '—',
      moi: res.status === 201 ? 'mới' : 'đã có',
    });
  }
  console.table(rows);
  console.log(`Đăng nhập app bằng email ở trên; mã OTP xem ở ${MAILPIT}.`);
} finally {
  await db?.end();
}
