import { defineConfig } from 'drizzle-kit';

// Migration chạy bằng vai trò teachhub_owner (Mục 9.2), không dùng vai trò của api.
export default defineConfig({
  dialect: 'postgresql',
  schema: './libs/db/src/schema',
  out: './libs/db/migrations',
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? '' },
  casing: 'snake_case',
});
