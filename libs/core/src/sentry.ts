import * as Sentry from '@sentry/nestjs';
import type { Event } from '@sentry/nestjs';
import { z } from 'zod';
import { sentryEnvShape } from './config.js';

// Header giữ lại (allowlist): mọi header khác (authorization, cookie, x-admin-secret, idempotency-key,
// x-revenuecat-*…) bị bỏ, kể cả header sau này mới thêm.
const SAFE_HEADERS = new Set([
  'user-agent',
  'content-type',
  'accept',
  'accept-language',
  'x-request-id',
  'host',
]);
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// SĐT Việt Nam: 0xxxxxxxxx / 84xxxxxxxxx / +84xxxxxxxxx, cho phép dấu cách . -
const PHONE = /(?<![\d])(?:\+84|84|0)(?:[\s.-]?\d){9}(?!\d)/g;

export const scrubText = (s: string): string =>
  s.replace(EMAIL, '[email]').replace(PHONE, '[phone]');

const scrubDeep = (v: unknown, depth = 0): unknown => {
  if (typeof v === 'string') return scrubText(v);
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, scrubDeep(x, depth + 1)]),
  );
};

/** Hàm thuần cho `beforeSend`: bỏ body/cookie/query/header nhạy cảm/user (trừ id), scrub email + SĐT. */
export function scrubEvent<T extends Event>(event: T): T {
  const e = scrubDeep(event) as T;
  if (e.request) {
    const { url, method, headers } = e.request;
    e.request = {
      ...(url && { url: url.split(/[?#]/)[0] }),
      ...(method && { method }),
      ...(headers && {
        headers: Object.fromEntries(
          Object.entries(headers).filter(([k]) =>
            SAFE_HEADERS.has(k.toLowerCase()),
          ),
        ),
      }),
    };
  }
  if (e.user) e.user = e.user.id ? { id: e.user.id } : undefined;
  if (e.breadcrumbs) {
    e.breadcrumbs = e.breadcrumbs.map((b) =>
      b.category === 'http' || b.category === 'fetch'
        ? { ...b, data: undefined }
        : b,
    );
  }
  return e;
}

/** Lỗi job BullMQ ở lần thất bại cuối: chỉ tên queue + tên job, không payload. */
export function captureJobFailure(
  job:
    | {
        name: string;
        queueName: string;
        attemptsMade: number;
        opts: { attempts?: number };
      }
    | undefined,
  err: Error,
): void {
  if (job && job.attemptsMade < (job.opts.attempts ?? 1)) return;
  Sentry.withScope((scope) => {
    scope.setTag('job', job?.name ?? 'unknown');
    scope.setTag('queue', job?.queueName ?? 'unknown');
    Sentry.captureException(err);
  });
}

/** Chỉ bật khi có SENTRY_DSN. Gọi trước mọi import khác của app (instrument.ts). */
export function initSentry(
  raw: Record<string, unknown> = process.env,
  overrides: Partial<Sentry.NodeOptions> = {},
): void {
  const env = z.object(sentryEnvShape).parse(raw);
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: typeof raw.NODE_ENV === 'string' ? raw.NODE_ENV : 'unknown',
    release: env.APP_VERSION,
    // v11 thay `sendDefaultPii` bằng `dataCollection` và mặc định cho thu thập RỘNG: tắt hết, beforeSend lọc thêm lớp nữa.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
    },
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    beforeSend: scrubEvent,
    ...overrides,
  });
}
