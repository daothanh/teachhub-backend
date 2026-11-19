// Seed dữ liệu dev: liên kết hai phụ huynh (X = cha, Y = mẹ) với một học viên để thử luồng báo vắng trước khi có
// luồng mời phụ huynh (Sprint 4). Ghi thẳng `guardians.user_id`, chỉ chạy ở môi trường dev.
// Dùng: pnpm seed:dev --student <uuid> --parent-x <email> --parent-y <email>
//   (kết nối bằng WORKER_DATABASE_URL, role teachhub_worker bỏ qua RLS; idempotent, chạy lại không tạo trùng)
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';

const DEV_ENVS = ['local', 'development', 'test'];

/** Chặn cứng: phải khai báo NODE_ENV rõ ràng là môi trường dev. Thiếu hoặc staging/production → ném lỗi. */
export function assertDevEnvironment(env = process.env) {
  if (!DEV_ENVS.includes(env.NODE_ENV ?? '')) {
    throw new Error(
      `seed:dev chỉ chạy ở môi trường dev (NODE_ENV thuộc ${DEV_ENVS.join('/')}), hiện là "${env.NODE_ENV ?? ''}"`,
    );
  }
}

/**
 * Chặn thêm: host DB phải là máy local (localhost, 127.0.0.1, ::1) hoặc tên service docker (không có dấu chấm).
 * Host khác (vd RDS) chỉ chạy khi có cờ `--i-know`.
 */
export function assertLocalDatabase(url, force = false) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const local =
    ['localhost', '127.0.0.1', '::1'].includes(host) || !host.includes('.');
  if (!local && !force)
    throw new Error(
      `seed:dev từ chối host DB "${host}" (không phải local). Thêm --i-know nếu thật sự muốn.`,
    );
}

/** Tạo (nếu thiếu) user + vai trò `parent` + đặt vai trò đang mở, rồi trả userId. */
async function ensureParent(db, email) {
  const found = await db.query(`select id from users where email = $1`, [
    email,
  ]);
  const userId = found.rows[0]?.id ?? randomUUID();
  if (!found.rows.length)
    await db.query(
      `insert into users (id, email, display_name) values ($1, $2, $3)`,
      [userId, email, email.split('@')[0]],
    );
  let m = (
    await db.query(
      `select id from memberships where user_id = $1 and role = 'parent' and status = 'active'`,
      [userId],
    )
  ).rows[0]?.id;
  if (!m) {
    m = randomUUID();
    await db.query(
      `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
      [m, userId],
    );
  }
  await db.query(
    `update users set last_membership_id = coalesce(last_membership_id, $1) where id = $2`,
    [m, userId],
  );
  return userId;
}

/** Liên kết X (cha) và Y (mẹ) với học viên; trả `{ x, y }` là userId. */
export async function linkParents(pool, { studentId, parentX, parentY }) {
  const db = await pool.connect();
  try {
    await db.query('begin');
    const st = (
      await db.query(`select tenant_id from students where id = $1`, [
        studentId,
      ])
    ).rows[0];
    if (!st) throw new Error(`Không có học viên ${studentId}`);
    const out = {};
    for (const [key, email, relation] of [
      ['x', parentX, 'father'],
      ['y', parentY, 'mother'],
    ]) {
      const userId = await ensureParent(db, email);
      out[key] = userId;
      const has = await db.query(
        `select 1 from guardians where tenant_id = $1 and student_id = $2 and user_id = $3 and deleted_at is null`,
        [st.tenant_id, studentId, userId],
      );
      if (!has.rows.length)
        await db.query(
          `insert into guardians (id, tenant_id, student_id, full_name, relation, email, user_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            st.tenant_id,
            studentId,
            email.split('@')[0],
            relation,
            email,
            userId,
          ],
        );
    }
    await db.query('commit');
    return out;
  } catch (e) {
    await db.query('rollback');
    throw e;
  } finally {
    db.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  assertDevEnvironment();
  const { values } = parseArgs({
    options: {
      student: { type: 'string' },
      'parent-x': { type: 'string' },
      'parent-y': { type: 'string' },
    },
  });
  const url = process.env.WORKER_DATABASE_URL;
  if (!url || !values.student || !values['parent-x'] || !values['parent-y']) {
    console.error(
      'Thiếu WORKER_DATABASE_URL hoặc --student/--parent-x/--parent-y',
    );
    process.exit(1);
  }
  assertLocalDatabase(url, values['i-know']);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = await linkParents(pool, {
      studentId: values.student,
      parentX: values['parent-x'],
      parentY: values['parent-y'],
    });
    console.log(
      `Đã liên kết phụ huynh X (${r.x}) và Y (${r.y}) với học viên ${values.student}.`,
    );
  } finally {
    await pool.end();
  }
}
