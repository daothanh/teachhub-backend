import { z } from 'zod';

const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Mỗi môi trường chỉ nhận client của đúng project Google của nó (danh sách trắng theo số project).
const GOOGLE_PROJECT_PREFIX: Record<string, string> = {
  development: '305225338991-', // dayhoc-dev
  staging: '753323722874-', // dayhoc-stg
  production: '432762025168-', // dayhoc-4c6db
};
// Client Android debug của production (khóa ký debug ai cũng dựng được): không bao giờ được vào production.
const GOOGLE_PROD_DEBUG_CLIENT_ID =
  '432762025168-3i1f3r2a7oelb9hg7pusr9uqc48umcdh.apps.googleusercontent.com';
const GOOGLE_JWKS_DEFAULT_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_CLIENT_ID_FORMAT = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

const isLocalOrTest = (v: string | undefined) => v === 'local' || v === 'test';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['local', 'development', 'staging', 'production', 'test'])
      // Thiếu = không phải local: không bao giờ rơi về khóa mặc định `dev-only-...`.
      .optional(),
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
    EMAIL_FROM: z.string().min(1).default('DayHoc <no-reply@dayhoc.app>'),
    /** Client ID OAuth Google (Web, iOS, Android upload), ngăn cách bởi dấu phẩy — `aud` hợp lệ của id_token. Bắt buộc ngoài local/test; trống = từ chối mọi id_token. */
    GOOGLE_CLIENT_IDS: z.string().default('').transform(csv),
    /** Khóa công khai của Google; test trỏ về JWKS giả. */
    GOOGLE_JWKS_URL: z.url().default(GOOGLE_JWKS_DEFAULT_URL),
    /** Bundle ID (ngăn cách bởi dấu phẩy) — `aud` hợp lệ của identityToken Apple. Trống = từ chối mọi token Apple. */
    APPLE_BUNDLE_ID: z.string().default('').transform(csv),
    /** Khóa công khai của Apple; test trỏ về JWKS giả. */
    APPLE_JWKS_URL: z.url().default('https://appleid.apple.com/auth/keys'),
    /** Số proxy tin cậy phía trước api (đọc lúc dựng Fastify trong app.ts). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
    /** Nhân mọi giới hạn tần suất theo IP (test e2e đặt lớn để không vướng). */
    RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
    /** Khóa ký access token ES256, PEM PKCS#8 (`\n` được chấp nhận). Bỏ trống chỉ ở local/test: sinh khóa tạm. */
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_KID: z.string().min(1).default('local'),
    /** Khóa cũ khi xoay vòng: PEM SPKI + kid, giữ tới khi access token cũ hết hạn (15 phút). */
    JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
    JWT_PREVIOUS_KID: z.string().optional(),
    /** Service account Firebase (JSON một dòng) để worker gửi FCM. Trống = tắt gửi push, worker vẫn chạy và log cảnh báo. */
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
    /** Webhook nhóm Lark nhận cảnh báo đối soát lệch (billing.reconcile, S6-BE-06). Trống = chỉ log lỗi. */
    ALERT_WEBHOOK_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().optional(),
    ),
    /** Phiên bản điều khoản/chính sách hiện hành (consents, S4-BE-05); đổi giá trị = mọi phụ huynh phải đồng ý lại. */
    CURRENT_TERMS_VERSION: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .default('2026-12-01'),
    /** Gốc link mời; token nằm ở fragment `#t=` nên không vào log máy chủ. */
    INVITE_BASE_URL: z.url().default('https://dayhoc.app/i'),
    /** Khóa HMAC băm IP của consents. Bắt buộc ngoài local/test; local/test dùng khóa tạm cố định. */
    CONSENT_IP_HMAC_KEY: z.string().min(16).optional(),
    /** Khóa HMAC băm mã mời ngắn (không gian 2^40: băm trơn dò được nếu lộ bảng). Bắt buộc ngoài local/test. */
    INVITE_CODE_HMAC_KEY: z.string().min(16).optional(),
    /** Khóa AES-256-GCM mã hóa phản hồi idempotency chứa token/mã mời. Bắt buộc ngoài local/test. */
    IDEMPOTENCY_ENC_KEY: z.string().min(16).optional(),
  })
  .superRefine((e, ctx) => {
    // Fail closed: chỉ local/test được dùng khóa tạm; development và mọi môi trường khác phải cấp khóa thật.
    if (!isLocalOrTest(e.NODE_ENV)) {
      const keys = [
        'CONSENT_IP_HMAC_KEY',
        'INVITE_CODE_HMAC_KEY',
        'IDEMPOTENCY_ENC_KEY',
      ] as const;
      for (const k of keys) {
        if (!e[k]) {
          ctx.addIssue({
            code: 'custom',
            path: [k],
            message: 'Bắt buộc ngoài local/test',
          });
        }
      }
      const set = keys.map((k) => e[k]).filter(Boolean);
      if (new Set(set).size !== set.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['CONSENT_IP_HMAC_KEY'],
          message:
            'Ba khóa CONSENT_IP_HMAC_KEY, INVITE_CODE_HMAC_KEY, IDEMPOTENCY_ENC_KEY phải khác nhau',
        });
      }
    }
    // Google: ngoài local/test phải có danh sách `aud`, đúng dạng client ID; production cấm client debug.
    if (!isLocalOrTest(e.NODE_ENV)) {
      const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', path: ['GOOGLE_CLIENT_IDS'], message });
      if (e.GOOGLE_CLIENT_IDS.length === 0) issue('Bắt buộc ngoài local/test');
      for (const id of e.GOOGLE_CLIENT_IDS) {
        if (!GOOGLE_CLIENT_ID_FORMAT.test(id)) {
          issue(
            'Mỗi client ID phải có dạng <số>-<chuỗi>.apps.googleusercontent.com',
          );
        } else if (
          e.NODE_ENV === 'production' &&
          id === GOOGLE_PROD_DEBUG_CLIENT_ID
        ) {
          issue('Production không nhận client Android debug');
        } else if (
          GOOGLE_PROJECT_PREFIX[e.NODE_ENV ?? ''] &&
          !id.startsWith(GOOGLE_PROJECT_PREFIX[e.NODE_ENV!]!)
        ) {
          issue(
            `${e.NODE_ENV} chỉ nhận client của project ${GOOGLE_PROJECT_PREFIX[e.NODE_ENV!]}*`,
          );
        }
      }
      if (e.GOOGLE_JWKS_URL !== GOOGLE_JWKS_DEFAULT_URL)
        ctx.addIssue({
          code: 'custom',
          path: ['GOOGLE_JWKS_URL'],
          message: 'Ngoài local/test chỉ nhận URL JWKS mặc định của Google',
        });
    }
    if (e.NODE_ENV !== 'staging' && e.NODE_ENV !== 'production') return;
    for (const k of ['APPLE_BUNDLE_ID'] as const) {
      if (e[k].length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: [k],
          message: 'Bắt buộc ở staging/production',
        });
      }
    }
  })
  .refine((e) => e.JWT_PRIVATE_KEY || isLocalOrTest(e.NODE_ENV), {
    path: ['JWT_PRIVATE_KEY'],
    message: 'Bắt buộc ngoài local/test',
  });

export type Env = z.infer<typeof envSchema>;

/** Khóa bí mật của `name`. Thiếu thì chỉ local/test dùng khóa tạm cố định; môi trường khác ném lỗi (fail closed). */
export const secretKey = (value: string | undefined, name: string): string => {
  if (value) return value;
  if (isLocalOrTest(process.env.NODE_ENV)) {
    return `dev-only-${name}-khong-dung-o-staging-production`;
  }
  throw new Error(`Thiếu khóa bí mật ${name}`);
};

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
