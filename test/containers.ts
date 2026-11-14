import { readFileSync } from 'node:fs';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  url: (role: 'teachhub_owner' | 'teachhub_app' | 'teachhub_worker') => string;
}

/** PostgreSQL 17 với vai trò như local (docker/postgres-init) và đã chạy migration. */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = (role: string) =>
    `postgres://${role}:${role}@${container.getHost()}:${container.getPort()}/teachhub`;

  // Chạy lại script init local (bỏ meta-command \connect của psql).
  const [roles, afterConnect] = readFileSync(
    'docker/postgres-init/01-roles.sql',
    'utf8',
  ).split('\\connect teachhub');
  const admin = new pg.Client({
    connectionString: container.getConnectionUri(),
  });
  await admin.connect();
  // Multi-statement query chạy trong một giao dịch ngầm; CREATE DATABASE phải chạy riêng.
  for (const stmt of (roles ?? '')
    .split(';')
    .map((x) => x.replace(/--.*$/gm, '').trim())
    .filter(Boolean)) {
    await admin.query(stmt);
  }
  await admin.end();
  const adminDb = new pg.Client({
    connectionString: container
      .getConnectionUri()
      .replace(/\/[^/]+$/, '/teachhub'),
  });
  await adminDb.connect();
  await adminDb.query(afterConnect ?? '');
  await adminDb.end();

  const owner = new pg.Pool({ connectionString: url('teachhub_owner') });
  await migrate(drizzle(owner), { migrationsFolder: 'libs/db/migrations' });
  await owner.end();

  return { container, url };
}
