import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import {
  AppException,
  type Env,
  type RequestContext,
  secretKey,
  uuidv7,
} from '@teachhub/core';
import { type Tx, TxService } from '@teachhub/db';
import { ConsentsService, MembershipCache } from '@teachhub/modules/identity';
import { hashShortCode, hashToken } from '../domain/invite-secrets.js';
import type { InviteAccepted, InvitePreview } from '../http/invites.schemas.js';
import { InviteAttemptLimiter } from './invite-attempt-limiter.js';

export interface AcceptInput {
  kind: 'token' | 'code';
  /** Token hoặc mã ngắn người dùng gửi; không bao giờ log. */
  secret: string;
  ctx: RequestContext;
  ip: string;
  /** Header `Idempotency-Key` thô (nếu có) để nhận ra phát lại. */
  idempotencyKey: string | undefined;
}

/**
 * Phụ huynh xem trước / nhận lời mời (US-0.3, US-0.12). Mọi nhánh thất bại cùng ném `INVITE_INVALID` sau đúng một
 * câu truy vấn nên không phân biệt được token sai, hết hạn, đã dùng hay bị thu hồi. Không log token, mã, body.
 */
@Injectable()
export class InviteAcceptanceService {
  constructor(
    private readonly tx: TxService,
    private readonly config: ConfigService<Env, true>,
    private readonly limiter: InviteAttemptLimiter,
    private readonly consents: ConsentsService,
    private readonly cache: MembershipCache,
  ) {}

  private codeHash(code: string): string {
    return hashShortCode(
      code,
      secretKey(
        this.config.get('INVITE_CODE_HMAC_KEY'),
        'INVITE_CODE_HMAC_KEY',
      ),
    );
  }

  async preview(token: string, ip: string): Promise<InvitePreview> {
    const slot = await this.limiter.reserve('preview', null, ip);
    let r:
      | {
          teacher_name: string;
          student_given_name: string;
          expires_at: Date | string;
        }
      | undefined;
    try {
      r = (
        await this.tx.run(
          { userId: null },
          async (t) =>
            (
              await t.execute<{
                teacher_name: string;
                student_given_name: string;
                expires_at: Date | string;
              }>(
                sql`select * from app_private.preview_invite(${hashToken(token)})`,
              )
            ).rows,
        )
      )[0];
    } catch (e) {
      await this.limiter.release(slot);
      throw e;
    }
    if (!r) throw new AppException('INVITE_INVALID'); // giữ lượt đã giữ = một lần sai
    await this.limiter.release(slot);
    return {
      teacherName: r.teacher_name,
      studentGivenName: r.student_given_name,
      expiresAt: new Date(r.expires_at).toISOString(),
    };
  }

  /**
   * Thứ tự cố định: bộ đếm/khóa → đã đồng ý điều khoản → tra mã. `run` là bước ghi (thường bọc trong
   * `Idempotency.run`) và nhận `Tx`; ném `INVITE_INVALID` khi không có lời mời hợp lệ.
   */
  async accept(
    input: AcceptInput,
    run: (exec: (t: Tx) => Promise<InviteAccepted>) => Promise<InviteAccepted>,
  ): Promise<InviteAccepted> {
    const userId = input.ctx.userId!;
    // Giữ chỗ nguyên tử trước (bộ đếm toàn cục chỉ cho mã ngắn), rồi mới tới đồng ý điều khoản và tra mã.
    const slot = await this.limiter.reserve(
      'accept',
      userId,
      input.ip,
      input.kind === 'code',
    );
    let counted = false;
    try {
      await this.consents.assertAccepted(userId, 'parent');
      const marker = createHash('sha256')
        .update(
          `${userId}|${input.kind}|${input.idempotencyKey ?? ''}|${input.secret}`,
        )
        .digest('hex');
      // Phát lại cùng Idempotency-Key một yêu cầu đã trả 410: trả lại 410, không đếm thêm lần sai.
      if (input.idempotencyKey && (await this.limiter.seenFailure(marker))) {
        throw new AppException('INVITE_INVALID');
      }
      const hash =
        input.kind === 'token'
          ? hashToken(input.secret)
          : this.codeHash(input.secret);
      try {
        const result = await run(async (t) => {
          const rows = (
            await t.execute<{
              membership_id: string;
              student_id: string;
              student_name: string;
            }>(
              sql`select * from app_private.redeem_invite(${input.kind === 'code'}, ${hash}, ${uuidv7()})`,
            )
          ).rows;
          const r = rows[0];
          if (!r) throw new AppException('INVITE_INVALID');
          return {
            membershipId: r.membership_id,
            studentId: r.student_id,
            studentName: r.student_name,
          };
        });
        // Vai trò Phụ huynh mới phải có hiệu lực ngay với token đang dùng (như POST /me/roles).
        await this.cache.invalidate(userId);
        return result;
      } catch (e) {
        if (e instanceof AppException && e.code === 'INVITE_INVALID') {
          counted = true;
          if (input.idempotencyKey) await this.limiter.markFailure(marker);
        }
        throw e;
      }
    } finally {
      // Thành công, phát lại (đã có marker), 403 chưa đồng ý hay lỗi hệ thống: không phải lần sai mới → hoàn lượt.
      if (!counted) await this.limiter.release(slot);
    }
  }
}
