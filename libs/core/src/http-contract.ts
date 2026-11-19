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

/** Lỗi có `details` kiểu cố định: khai một mã lỗi kèm schema của `details` (vd. 402 hết hạn mức gói). */
export function ApiErrorWithDetails(
  code: ErrorCode,
  id: string,
  details: z.ZodType,
) {
  return ApiResponse({
    status: ERROR_CODES[code].http,
    description: code,
    standardSchema: errorBodySchema.extend({ details }).meta({ id }),
  });
}

/** 402 `PLAN_LIMIT_EXCEEDED` (Mục 5.6): `details` cho client biết đang vượt mức nào. */
export const planLimitDetailsSchema = z.object({
  limit: z.int().min(0),
  current: z.int().min(0),
  attempted: z.int().min(1),
  feature: z.string().meta({ example: 'max_active_students' }),
});
export const ApiPlanLimitExceeded = () =>
  ApiErrorWithDetails(
    'PLAN_LIMIT_EXCEEDED',
    'PlanLimitErrorBody',
    planLimitDetailsSchema,
  );

/** Lệnh ghi nhận `Idempotency-Key` (Mục 5.1): một khóa cho một ý định, giữ nguyên khi retry. */
export function ApiIdempotencyKey(required = true) {
  return applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required,
      description: 'UUID, giữ nguyên khi thử lại hoặc phát lại từ outbox',
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiErrors('IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS'),
  );
}

/** Thân danh sách phân trang offset (Mục 5.5): `{ items, total, page, pageSize }`. */
export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.int().min(0),
    page: z.int().min(1),
    pageSize: z.int().min(1),
  });
