import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppException } from './app.exception.js';
import { ERROR_CODES, type ErrorCode } from './error-codes.js';

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'BAD_REQUEST',
  415: 'BAD_REQUEST',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  errors?: Record<string, string[]>;
  requestId?: string;
}

/** Mọi lỗi trả về đúng dạng Mục 5.6: `{ code, message, details?, errors?, requestId }`. */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const { status, body } = toErrorBody(exception);
    body.requestId = req.id;
    if (status >= 500) this.logger.error(loggable(exception));
    // 429 (RATE_LIMITED, OTP_LOCKED): client đọc được cả header chuẩn lẫn details (§5.6).
    const retryAfter = body.details?.retryAfterSec;
    if (typeof retryAfter === 'number') {
      void reply.header('Retry-After', String(retryAfter));
    }
    void reply.status(status).send(body);
  }
}

const MAX_CAUSE_DEPTH = 5;

/** Một cấp lỗi: tên, message cắt phần `params:`, frame `at` của stack gốc, `code`/`constraint`; không `detail`/`params`. */
function scrub(err: Error, depth: number): Error {
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  const safe = Object.assign(new Error(err.message.split('\nparams:')[0]), {
    name: err.name,
    ...(typeof code === 'string' && { code }),
    ...(typeof constraint === 'string' && { constraint }),
  });
  safe.stack =
    `${safe.name}: ${safe.message}\n` +
    (err.stack ?? '')
      .split('\n')
      .filter((l) => /^\s+at /.test(l))
      .join('\n');
  if (err.cause instanceof Error && depth < MAX_CAUSE_DEPTH) {
    safe.cause = scrub(err.cause, depth + 1);
  }
  return safe;
}

/**
 * Lỗi truy vấn của Drizzle mang theo cả câu SQL lẫn `params` (họ tên, SĐT học viên…), và lỗi gốc của driver có
 * `detail` kiểu `Key (full_name)=(…)`. Lỗi truy vấn được dựng lại theo cả chuỗi `cause` (mỗi cấp chỉ giữ message
 * rút gọn và frame `at`, vì dòng đầu của stack chứa message gốc); lỗi khác giữ nguyên.
 */
export function loggable(exception: unknown): unknown {
  return exception instanceof Error &&
    ('params' in exception || 'query' in exception)
    ? scrub(exception, 0)
    : exception;
}

export function toErrorBody(exception: unknown): {
  status: number;
  body: ErrorBody;
} {
  if (exception instanceof AppException) {
    const def = ERROR_CODES[exception.code];
    return {
      status: def.http,
      body: {
        code: exception.code,
        message: def.message,
        details: exception.details,
        errors: exception.errors,
      },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code =
      CODE_BY_STATUS[status] ??
      (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    return { status, body: { code, message: ERROR_CODES[code].message } };
  }
  return {
    status: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: ERROR_CODES.INTERNAL_ERROR.message,
    },
  };
}
