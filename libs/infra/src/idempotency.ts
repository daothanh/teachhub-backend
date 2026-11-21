import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import {
  AppException,
  type Env,
  type RequestContext,
  secretKey,
  uuidv7,
} from '@teachhub/core';
import { idempotencyKeys, type Tx, TxService } from '@teachhub/db';
import { REDIS } from './redis.module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_SEC = 60;
/** Phản hồi chứa bí mật (token/mã mời) chỉ phát lại được trong khoảng này; sau đó phải dùng khóa mới. */
const SENSITIVE_TTL_MS = 10 * 60_000;

export interface IdempotencyOptions {
  /**
   * Phản hồi có bí mật (token/mã mời): lưu mã hóa AES-256-GCM (khóa `IDEMPOTENCY_ENC_KEY`, gắn với user + route +
   * khóa để không đem sang dòng khác được) và chỉ phát lại trong 10 phút; quá hạn → 409 `CONFLICT_STALE`.
   */
  sensitive?: boolean;
}

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
    private readonly config: ConfigService<Env, true>,
  ) {}

  private encKey(): Buffer {
    return createHash('sha256')
      .update(
        secretKey(
          this.config.get('IDEMPOTENCY_ENC_KEY'),
          'IDEMPOTENCY_ENC_KEY',
        ),
      )
      .digest();
  }

  private seal(body: unknown, aad: string): { enc: string } {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey(), iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(JSON.stringify(body)), c.final()]);
    return { enc: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
  }

  private open<T>(sealed: { enc: string }, aad: string): T {
    const raw = Buffer.from(sealed.enc, 'base64');
    const d = createDecipheriv(
      'aes-256-gcm',
      this.encKey(),
      raw.subarray(0, 12),
    );
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'),
    ) as T;
  }

  async run<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    ctx: RequestContext,
    fn: (t: Tx) => Promise<IdempotentResult<T>>,
    opts: IdempotencyOptions = {},
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
    const aad = `${userId}|${endpoint}|${key}`;
    // Cùng key + cùng body nhưng khác đích (id trên đường dẫn) hoặc khác tenant không phải cùng một yêu cầu.
    const payload = canonical({
      body: req.body,
      params: req.params,
      tenantId: ctx.tenantId ?? null,
    });
    // Route nhạy cảm: body có token/mã mời (không gian nhỏ) nên băm có khóa, không để SHA-256 trơn dò ngược được.
    const requestHash = (
      opts.sensitive
        ? createHmac('sha256', this.encKey())
        : createHash('sha256')
    )
      .update(payload)
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
      if (opts.sensitive) {
        if (Date.now() - done.createdAt.getTime() > SENSITIVE_TTL_MS) {
          throw new AppException('CONFLICT_STALE');
        }
        void reply
          .status(done.statusCode)
          .header('Idempotent-Replayed', 'true')
          .header('Cache-Control', 'no-store');
        try {
          return this.open<T>(done.responseBody as { enc: string }, aad);
        } catch {
          // Giải mã lỗi (đã đổi IDEMPOTENCY_ENC_KEY, dữ liệu hỏng): bắt client dùng khóa mới, không 500.
          throw new AppException('CONFLICT_STALE');
        }
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
          responseBody: opts.sensitive ? this.seal(r.body, aad) : r.body,
        });
        return r;
      });
      void reply.status(result.status);
      if (opts.sensitive) void reply.header('Cache-Control', 'no-store');
      return result.body;
    } finally {
      await this.redis.del(lock);
    }
  }
}

@Global()
@Module({ providers: [Idempotency], exports: [Idempotency] })
export class IdempotencyModule {}
