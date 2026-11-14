import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from './error-codes.js';

/** Thân lỗi chuẩn (Mục 5.6). `code` để dạng chuỗi: danh mục đầy đủ ở contracts/error_codes.json. */
export const errorBodySchema = z
  .object({
    code: z
      .string()
      .meta({ description: 'Mã trong contracts/error_codes.json' }),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    errors: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .meta({ description: 'Chỉ có với VALIDATION_FAILED: lỗi theo trường' }),
    requestId: z.string(),
  })
  .meta({ id: 'ErrorBody' });

/** Khai các mã lỗi endpoint có thể trả vào OpenAPI, gom theo HTTP status. */
export function ApiErrors(...codes: ErrorCode[]) {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_CODES[code].http;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return applyDecorators(
    ...[...byStatus].map(([status, list]) =>
      ApiResponse({
        status,
        description: list.join(', '),
        standardSchema: errorBodySchema,
      }),
    ),
  );
}

/** Lệnh ghi nhận `Idempotency-Key` (Mục 5.1): một khóa cho một ý định, giữ nguyên khi retry. */
export function ApiIdempotencyKey() {
  return applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: 'UUID, giữ nguyên khi thử lại hoặc phát lại từ outbox',
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiErrors('IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS'),
  );
}
