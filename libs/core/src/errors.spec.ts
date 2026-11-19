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
  const PII = ['Nguyễn Văn A', '0912345678'];
  /** Mọi thứ log có thể in ra: message, stack và các trường tự có của object. */
  const dump = (e: unknown) =>
    JSON.stringify([
      (e as Error).message,
      (e as Error).stack,
      Object.fromEntries(
        Object.getOwnPropertyNames(e).map((k) => [k, (e as never)[k]]),
      ),
    ]);

  it('lỗi truy vấn Drizzle có lỗi gốc: không còn params/detail (PII) ở message, stack hay trường nào', () => {
    const driver = Object.assign(
      new Error('duplicate key value violates unique constraint "x"'),
      {
        code: '23505',
        constraint: 'x',
        detail: 'Key (full_name)=(Nguyễn Văn A) already exists.',
      },
    );
    const drizzleErr = Object.assign(
      new Error(`Failed query: insert …\nparams: ${PII.join(',')}`),
      { query: 'insert …', params: PII, cause: driver },
    );
    const out = loggable(drizzleErr) as Error;
    expect(out.message).toBe('Failed query: insert …');
    const cause = out.cause as Error;
    expect(cause.message).toBe(driver.message);
    expect(cause).toMatchObject({ code: '23505', constraint: 'x' });
    expect(cause).not.toHaveProperty('detail');
    expect(out).not.toHaveProperty('params');
    expect(out.stack).toMatch(/^Error: Failed query: insert …\n\s+at /);
    for (const v of PII) {
      expect(dump(out)).not.toContain(v);
      expect(dump(cause)).not.toContain(v);
    }
  });

  it('lỗi truy vấn không có lỗi gốc: stack dựng lại từ message đã cắt, không dòng nào chứa params', () => {
    const err = Object.assign(
      new Error(`Failed query: insert …\nparams: ${PII.join(',')}`),
      { query: 'insert …', params: PII },
    );
    expect(err.stack).toContain('0912345678'); // stack gốc quả có PII ở dòng đầu
    const out = loggable(err) as Error;
    expect(out.message).toBe('Failed query: insert …');
    expect(out.stack).toContain('\n    at ');
    expect(out).not.toHaveProperty('params');
    expect(out).not.toHaveProperty('query');
    for (const v of PII) expect(dump(out)).not.toContain(v);
  });

  it('đi theo chuỗi cause: cấp nào cũng chỉ giữ message rút gọn + frame at', () => {
    const root = Object.assign(new Error('Key (phone)=(0912345678) sai'), {
      code: '22P02',
    });
    const mid = new Error(`mid\nparams: ${PII.join(',')}`, { cause: root });
    const top = Object.assign(new Error(`Failed\nparams: ${PII.join(',')}`), {
      query: 'q',
      params: PII,
      cause: mid,
    });
    const out = loggable(top) as Error;
    const chain = [
      out,
      out.cause as Error,
      (out.cause as Error).cause as Error,
    ];
    expect(chain.every((e) => e instanceof Error)).toBe(true);
    expect(chain[1]!.message).toBe('mid');
    expect(chain[2]).toMatchObject({ code: '22P02' });
    for (const e of chain) {
      expect(e.stack).toMatch(/^[^\n]*\n\s+at /);
      expect(e.stack?.split('\n')[0]).toBe(`${e.name}: ${e.message}`);
    }
    // message của cấp gốc không bị cắt `params:` nhưng vẫn là message driver, không detail
    expect(JSON.stringify(out, Object.getOwnPropertyNames(out))).not.toContain(
      'Nguyễn',
    );
  });

  it('lỗi khác giữ nguyên', () => {
    const other = new Error('x');
    expect(loggable(other)).toBe(other);
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
