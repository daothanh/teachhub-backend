import errorCodes from '../../../contracts/error_codes.json' with { type: 'json' };

// Nguồn duy nhất: contracts/error_codes.json (app/web sinh hằng số từ cùng file).
export type ErrorCode = keyof typeof errorCodes;
export const ERROR_CODES: Record<ErrorCode, { http: number; message: string }> =
  errorCodes;
