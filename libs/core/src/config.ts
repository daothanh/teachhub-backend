import { z } from 'zod';

export const envSchema = z
  .object({
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
    /** Kho S3 (Mục 2.8): MinIO ở local/dev, R2 ở staging/production — chỉ khác giá trị. Bỏ trống = AWS S3. */
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1),
    /** MinIO cần path-style; R2 và AWS S3 thì không. */
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_BUCKET_PRIVATE: z.string().min(1),
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
    /** SMTP gửi email (OTP…): Mailpit ở local/dev (smtp://127.0.0.1:1025), SES SMTP ở staging/production. */
    SMTP_URL: z.url().default('smtp://127.0.0.1:1025'),
    EMAIL_FROM: z.string().min(1).default('TeachHub <no-reply@teachhub.vn>'),
    /** Client ID OAuth Google (iOS, Android, web), ngăn cách bởi dấu phẩy — `aud` hợp lệ của id_token. Trống = từ chối mọi id_token. */
    GOOGLE_CLIENT_IDS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    /** Khóa công khai của Google; test trỏ về JWKS giả. */
    GOOGLE_JWKS_URL: z
      .url()
      .default('https://www.googleapis.com/oauth2/v3/certs'),
    /** Khóa ký access token ES256, PEM PKCS#8 (`\n` được chấp nhận). Bỏ trống chỉ ở local/test: sinh khóa tạm. */
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_KID: z.string().min(1).default('local'),
    /** Khóa cũ khi xoay vòng: PEM SPKI + kid, giữ tới khi access token cũ hết hạn (15 phút). */
    JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
    JWT_PREVIOUS_KID: z.string().optional(),
  })
  .refine((e) => e.JWT_PRIVATE_KEY || ['local', 'test'].includes(e.NODE_ENV), {
    path: ['JWT_PRIVATE_KEY'],
    message: 'Bắt buộc ngoài local/test',
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
