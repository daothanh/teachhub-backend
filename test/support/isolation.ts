import { randomUUID } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import type pg from 'pg';
import type { TxService } from '@teachhub/db';

/**
 * Bộ khung test chéo tenant / chéo học viên (Technical Spec §4.5 R5), dùng lại cho mọi module.
 * - A, B: giáo viên của hai tenant khác nhau.
 * - X, Y: phụ huynh của hai học viên khác nhau (cùng tenant A — lỗi hay gặp nhất là lộ trong cùng tenant).
 * Module dựng membership/guardian thật cho các actor này (Sprint 1+), rồi gọi các hàm expect* dưới đây.
 */
export function makeActors() {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  return {
    A: { userId: randomUUID(), tenantId: tenantA },
    B: { userId: randomUUID(), tenantId: tenantB },
    X: { userId: randomUUID(), tenantId: tenantA, studentId: randomUUID() },
    Y: { userId: randomUUID(), tenantId: tenantA, studentId: randomUUID() },
  };
}
export type Actors = ReturnType<typeof makeActors>;

const rowCount = (tx: TxService, userId: string | null, query: SQL) =>
  tx.run({ userId }, async (t) => (await t.execute(query)).rowCount ?? 0);

/**
 * Lớp 2 (RLS): `intruder` không đọc, sửa, xóa được bản ghi `rowId` của `owner`; thiếu `app.user_id` → 0 dòng.
 * Lớp 1 (API trả 404) kiểm riêng bằng `app.inject` khi module có endpoint.
 */
export async function expectRowIsolated(
  tx: TxService,
  opts: { table: string; rowId: string; owner: string; intruder: string },
): Promise<void> {
  const t = sql.identifier(opts.table);
  const select = sql`select 1 from ${t} where id = ${opts.rowId}`;
  expect(
    await rowCount(tx, opts.owner, select),
    'chủ sở hữu phải thấy bản ghi',
  ).toBe(1);
  expect(await rowCount(tx, opts.intruder, select), 'đọc chéo').toBe(0);
  expect(await rowCount(tx, null, select), 'thiếu app.user_id').toBe(0);
  expect(
    await rowCount(
      tx,
      opts.intruder,
      sql`update ${t} set id = id where id = ${opts.rowId}`,
    ),
    'sửa chéo',
  ).toBe(0);
  expect(
    await rowCount(
      tx,
      opts.intruder,
      sql`delete from ${t} where id = ${opts.rowId}`,
    ),
    'xóa chéo',
  ).toBe(0);
  expect(await rowCount(tx, opts.owner, select), 'bản ghi còn nguyên').toBe(1);
}

/** `with check` của policy chặn ghi bản ghi gắn vào tenant/học viên của người khác. */
export async function expectInsertRejected(
  tx: TxService,
  userId: string,
  insert: SQL,
  /** Mặc định: lỗi RLS. Truyền regex khác khi ràng buộc CSDL chặn trước. */
  expected: RegExp = /row-level security/,
): Promise<void> {
  const err: unknown = await tx
    .run({ userId }, (t) => t.execute(insert))
    .then(
      () => null,
      (e: unknown) => e,
    );
  // Drizzle bọc lỗi pg thành "Failed query…"; thông điệp RLS nằm ở `cause`.
  const message =
    err instanceof Error
      ? err.cause instanceof Error
        ? err.cause.message
        : err.message
      : '';
  expect(message, 'ghi chéo phải bị chặn').toMatch(expected);
}

/**
 * R1: bảng/phân vùng trong `public` chưa bật hoặc chưa ép RLS. Rỗng = đạt.
 * Chạy bằng vai trò bất kỳ (chỉ đọc catalog).
 */
export const tablesMissingRls = sql`
  select c.relname as table
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and not (c.relrowsecurity and c.relforcerowsecurity)
   order by 1`;

/**
 * Chạy `query` bằng teachhub_worker (BYPASSRLS) với app.user_id = `userId` — đứng thay hàm security
 * definer cấp vai trò/tạo tenant (POST /workspaces, S1-BE-08) khi dựng dữ liệu test.
 */
export async function asPrivileged(
  worker: pg.Pool,
  userId: string,
  query: string,
  params: unknown[] = [],
): Promise<void> {
  const c = await worker.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.user_id', $1, true)`, [userId]);
    await c.query(query, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
