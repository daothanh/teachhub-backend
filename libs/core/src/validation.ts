import {
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
} from '@nestjs/common';
import { AppException } from './app.exception.js';

type Issues = Parameters<
  NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>
>[0];

/** Gom issue của schema thành `{ field: string[] }`; issue không có path ghi vào `_`. */
export function toFieldErrors(issues: Issues): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key =
      issue.path
        ?.map((p) => String(typeof p === 'object' ? p.key : p))
        .join('.') || '_';
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

export const validationPipe = new StandardSchemaValidationPipe({
  exceptionFactory: (issues) =>
    new AppException('VALIDATION_FAILED', undefined, toFieldErrors(issues)),
});
