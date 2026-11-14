import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['local', 'development', 'staging', 'production', 'test'])
    .default('local'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  /** Vai trò teachhub_app (không BYPASSRLS) — dùng cho `api`. */
  DATABASE_URL: z.url(),
  /** Vai trò teachhub_worker (BYPASSRLS, Mục 4.5 R3) — chỉ `worker` cần. */
  WORKER_DATABASE_URL: z.url().optional(),
  REDIS_URL: z.url(),
  /** Danh sách origin cho CORS, ngăn cách bởi dấu phẩy. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof envSchema>;

/** Thiếu/sai biến môi trường → không khởi động (Mục 2.4). */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Biến môi trường không hợp lệ:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
