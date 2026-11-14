import type { ErrorCode } from './error-codes.js';

/** Lỗi nghiệp vụ. GlobalExceptionFilter ánh xạ `code` → HTTP theo contracts/error_codes.json. */
export class AppException extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: Record<string, unknown>,
    /** Lỗi theo trường (chỉ dùng cho VALIDATION_FAILED) — dạng web framework đọc. */
    readonly errors?: Record<string, string[]>,
  ) {
    super(code);
  }
}
