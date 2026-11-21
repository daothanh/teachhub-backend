import { readFileSync } from 'node:fs';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  MinioContainer,
  type StartedMinioContainer,
} from '@testcontainers/minio';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  url: (role: 'teachhub_owner' | 'teachhub_app' | 'teachhub_worker') => string;
}

/** PostgreSQL 17 với vai trò như local (docker/postgres-init) và đã chạy migration. */
export async function startTestDb(
  migrationsFolder = 'libs/db/migrations',
): Promise<TestDb> {
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

  const db = { container, url };
  await migrateTestDb(db, migrationsFolder);
  return db;
}

/** Chạy migration còn thiếu bằng teachhub_owner (thư mục khác mặc định: kiểm nâng cấp trên dữ liệu có sẵn). */
export async function migrateTestDb(
  db: Pick<TestDb, 'url'>,
  folder = 'libs/db/migrations',
): Promise<void> {
  const owner = new pg.Pool({ connectionString: db.url('teachhub_owner') });
  try {
    await migrate(drizzle(owner), { migrationsFolder: folder });
  } finally {
    await owner.end();
  }
}

// Cùng image đã ghim trong docker-compose.yml (minio/minio không còn trên Docker Hub).
export const MINIO_IMAGE =
  'chainguard/minio@sha256:0f9fda72fbc6bd3560ea903aec2ceefa20f6ba82628d67656f37fb370c39ae9c';

export interface TestS3 {
  container: StartedMinioContainer;
  /** Biến `S3_*` trỏ vào container, bucket private đã tạo. */
  env: Record<string, string>;
}

export async function startTestS3(): Promise<TestS3> {
  const container = await new MinioContainer(MINIO_IMAGE).start();
  const env = {
    S3_ENDPOINT: container.getConnectionUrl(),
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: container.getUsername(),
    S3_SECRET_ACCESS_KEY: container.getPassword(),
    S3_BUCKET_PRIVATE: 'teachhub-test-private',
  };
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET_PRIVATE }));
  s3.destroy();
  return { container, env };
}
