// Chạy migration bằng migrator của drizzle-orm (dependency production) — cùng cơ chế với `drizzle-kit migrate`
// nhưng image không phải mang drizzle-kit/esbuild. Vai trò: teachhub_owner (ADR-TH-BE-001 §2).
// Dùng: MIGRATION_DATABASE_URL=… node scripts/migrate.mjs
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Thiếu MIGRATION_DATABASE_URL');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: 'libs/db/migrations' });
  console.log('Migration xong.');
} finally {
  await pool.end();
}
