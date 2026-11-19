import { createHash } from 'node:crypto';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { AppException, type RequestContext, uuidv7 } from '@teachhub/core';
import { idempotencyKeys, type Tx, TxService } from '@teachhub/db';
import { REDIS } from './redis.module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_SEC = 60;

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

/** JSON với khóa đã sắp xếp: cùng nội dung, khác thứ tự trường → cùng băm. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * `Idempotency-Key` cho POST/PATCH ghi dữ liệu (Technical Spec §5.1). Phạm vi khóa = (user, method + route
 * template). Kết quả lưu vào `idempotency_keys` **trong cùng giao dịch** với dữ liệu nghiệp vụ: lỗi giữa chừng
 * thì cả hai cùng rollback, lần sau xử lý như mới.
 */
@Injectable()
export class Idempotency {
  constructor(
    private readonly tx: TxService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async run<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    ctx: RequestContext,
    fn: (t: Tx) => Promise<IdempotentResult<T>>,
  ): Promise<T> {
    const userId = ctx.userId;
    if (!userId) throw new AppException('UNAUTHENTICATED');
    const header = req.headers['idempotency-key'];
    const key = typeof header === 'string' ? header : '';
    if (!UUID.test(key)) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        'Idempotency-Key': ['Bắt buộc, dạng UUID'],
      });
    }
    const endpoint = `${req.method} ${req.routeOptions.url}`;
    const requestHash = createHash('sha256')
      // Cùng key + cùng body nhưng khác đích (id trên đường dẫn) hoặc khác tenant không phải cùng một yêu cầu.
      .update(
        canonical({
          body: req.body,
          params: req.params,
          tenantId: ctx.tenantId ?? null,
        }),
      )
      .digest('hex');

    const replay = async (): Promise<T | undefined> => {
      const [done] = await this.tx.run({ userId }, (t) =>
        t
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.userId, userId),
              eq(idempotencyKeys.endpoint, endpoint),
              eq(idempotencyKeys.key, key),
            ),
          ),
      );
      if (!done) return undefined;
      if (done.requestHash !== requestHash) {
        throw new AppException('IDEMPOTENCY_KEY_REUSED');
      }
      void reply.status(done.statusCode).header('Idempotent-Replayed', 'true');
      return done.responseBody as T;
    };

    const stored = await replay();
    if (stored !== undefined) return stored;

    const lock = `idem:lock:${userId}:${endpoint}:${key}`;
    if (!(await this.redis.set(lock, '1', 'EX', LOCK_SEC, 'NX'))) {
      throw new AppException('IDEMPOTENCY_IN_PROGRESS');
    }
    try {
      // Request trước vừa xong giữa lúc kiểm và lúc lấy khóa.
      const late = await replay();
      if (late !== undefined) return late;
      const result = await this.tx.run({ userId }, async (t) => {
        const r = await fn(t);
        await t.insert(idempotencyKeys).values({
          id: uuidv7(),
          userId,
          endpoint,
          key,
          requestHash,
          statusCode: r.status,
          responseBody: r.body,
        });
        return r;
      });
      void reply.status(result.status);
      return result.body;
    } finally {
      await this.redis.del(lock);
    }
  }
}

@Global()
@Module({ providers: [Idempotency], exports: [Idempotency] })
export class IdempotencyModule {}
