import errorCodes from '../../../contracts/error_codes.json' with { type: 'json' };
import { AppException } from './app.exception.js';
import { toErrorBody } from './global-exception.filter.js';
import { pageQuerySchema, paginated, toLimitOffset } from './pagination.js';
import { toFieldErrors } from './validation.js';

// API đọc thẳng contracts/error_codes.json (kiểu ErrorCode suy ra lúc biên dịch, không có bước sinh mã để quên).
// App (Dart) và web sinh hằng số từ cùng file, nên file phải luôn đúng dạng.
describe('contracts/error_codes.json', () => {
  it.each(Object.entries(errorCodes))('%s đúng dạng', (code, def) => {
    expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(def.http).toBeGreaterThanOrEqual(400);
    expect(def.http).toBeLessThan(600);
    expect(def.message.trim()).not.toBe('');
  });
});

// G12: client (web framework getFieldErrors, app ApiException) đọc đúng các khóa này.
describe('định dạng lỗi (Mục 5.6, G12)', () => {
  it('lỗi nghiệp vụ có details', () => {
    expect(toErrorBody(new AppException('PLAN_LIMIT_EXCEEDED', { limit: 20 })))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "code": "PLAN_LIMIT_EXCEEDED",
          "details": {
            "limit": 20,
          },
          "errors": undefined,
          "message": "Đã vượt giới hạn của gói.",
        },
        "status": 402,
      }
    `);
  });

  it('422 có errors theo trường ở gốc body', () => {
    const errors = toFieldErrors([
      { message: 'Vui lòng nhập tên lớp.', path: ['name'] },
      { message: 'Sai ngày.', path: [{ key: 'dates' }, 'end'] },
      { message: 'Thiếu dữ liệu.' },
    ]);
    expect(
      toErrorBody(new AppException('VALIDATION_FAILED', undefined, errors)),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "VALIDATION_FAILED",
          "details": undefined,
          "errors": {
            "_": [
              "Thiếu dữ liệu.",
            ],
            "dates.end": [
              "Sai ngày.",
            ],
            "name": [
              "Vui lòng nhập tên lớp.",
            ],
          },
          "message": "Dữ liệu chưa hợp lệ.",
        },
        "status": 422,
      }
    `);
  });
});

describe('phân trang', () => {
  it('mặc định page 1, pageSize 20; ép kiểu từ query string', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pageQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('chặn pageSize > 100 và page < 1', () => {
    expect(pageQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('đổi sang limit/offset và đóng gói kết quả', () => {
    const q = { page: 3, pageSize: 20 };
    expect(toLimitOffset(q)).toEqual({ limit: 20, offset: 40 });
    expect(paginated(['a'], 41, q)).toEqual({
      items: ['a'],
      total: 41,
      page: 3,
      pageSize: 20,
    });
  });
});
