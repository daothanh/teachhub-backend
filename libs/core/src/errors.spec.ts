import { HttpException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AppException } from './app.exception.js';
import { validateEnv } from './config.js';
import { reqLogSerializer } from './log-serializer.js';
import { loggable, toErrorBody } from './global-exception.filter.js';
import { validationPipe } from './validation.js';

describe('toErrorBody', () => {
  it('ánh xạ AppException theo contracts/error_codes.json', () => {
    const { status, body } = toErrorBody(
      new AppException('PLAN_LIMIT_EXCEEDED', { limit: 20 }),
    );
    expect(status).toBe(402);
    expect(body).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 20 },
    });
  });

  it('đổi HttpException của Nest sang mã chuẩn', () => {
    expect(toErrorBody(new NotFoundException()).body.code).toBe('NOT_FOUND');
    expect(toErrorBody(new HttpException('x', 502)).body.code).toBe(
      'INTERNAL_ERROR',
    );
  });

  it('lỗi lạ → 500 INTERNAL_ERROR, không lộ message gốc', () => {
    const { status, body } = toErrorBody(new Error('password=secret'));
    expect(status).toBe(500);
    expect(body.message).not.toContain('secret');
  });
});

describe('loggable', () => {
  it('lỗi truy vấn Drizzle: bỏ params (PII), chỉ giữ lỗi gốc của driver', () => {
    const driver = new Error('duplicate key value violates unique constraint');
    const drizzleErr = Object.assign(
      new Error('Failed query: insert … params: Nguyễn Văn A,0912345678'),
      {
        query: 'insert …',
        params: ['Nguyễn Văn A', '0912345678'],
        cause: driver,
      },
    );
    expect(loggable(drizzleErr)).toBe(driver);
    const other = new Error('x');
    expect(loggable(other)).toBe(other);
  });

  it('lỗi truy vấn không có lỗi gốc: vẫn không còn params/query/văn bản params', () => {
    const err = Object.assign(
      new Error('Failed query: insert …\nparams: Nguyễn Văn A,0912345678'),
      { query: 'insert …', params: ['Nguyễn Văn A', '0912345678'] },
    );
    const out = loggable(err) as Error;
    expect(out).not.toHaveProperty('params');
    expect(out).not.toHaveProperty('query');
    expect(
      JSON.stringify([out.message, out.stack?.split('\n')[0]]),
    ).not.toMatch(/0912345678|Nguyễn/);
  });
});

describe('reqLogSerializer', () => {
  it('log request bỏ query string (q = tên học viên) nhưng giữ method và đường dẫn', () => {
    const out = reqLogSerializer({
      id: 'r1',
      method: 'GET',
      url: '/v1/students?q=Nguy%E1%BB%85n&status=active',
      query: { q: 'Nguyễn' },
    });
    expect(out).toMatchObject({ method: 'GET', url: '/v1/students' });
    expect(JSON.stringify(out)).not.toMatch(/Nguy|q=/);
  });
});

describe('validationPipe', () => {
  const schema = z.object({
    name: z.string().min(1),
    dates: z.object({ end: z.iso.date() }),
  });

  it('ném VALIDATION_FAILED kèm errors theo trường (dạng web framework đọc)', async () => {
    const err = await validationPipe
      .transform({ name: '', dates: { end: 'x' } }, { type: 'body', schema })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    const { status, body } = toErrorBody(err);
    expect(status).toBe(422);
    expect(Object.keys(body.errors ?? {})).toEqual(['name', 'dates.end']);
  });
});

describe('validateEnv', () => {
  it('thiếu biến bắt buộc → không khởi động', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('tách CORS_ORIGINS thành mảng', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://a@b/c',
      REDIS_URL: 'redis://x',
      CORS_ORIGINS: 'a, b',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_BUCKET_PRIVATE: 'b',
    });
    expect(env.CORS_ORIGINS).toEqual(['a', 'b']);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });
});
