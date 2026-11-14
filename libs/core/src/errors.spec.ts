import { HttpException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AppException } from './app.exception.js';
import { validateEnv } from './config.js';
import { toErrorBody } from './global-exception.filter.js';
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
