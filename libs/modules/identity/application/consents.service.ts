import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { AppException, type Env, secretKey, uuidv7 } from '@teachhub/core';
import { consents, type Tx, TxService } from '@teachhub/db';
import type { Consent, ConsentStatus } from '../http/consents.schemas.js';

export type ConsentRole = 'parent';

const DEDUPE_SEC = 60;
const UA_MAX = 255;

const toConsent = (r: typeof consents.$inferSelect): Consent => ({
  id: r.id,
  role: r.role as ConsentRole,
  termsVersion: r.termsVersion,
  acceptedAt: r.acceptedAt.toISOString(),
});

/**
 * Đồng ý xử lý dữ liệu theo vai trò (FR-0.14). Bảng chỉ ghi thêm (quyền + trigger ở CSDL). Không log IP, user agent.
 */
@Injectable()
export class ConsentsService {
  constructor(
    private readonly tx: TxService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  currentTermsVersion(): string {
    return this.config.get('CURRENT_TERMS_VERSION');
  }

  /** HMAC của IP bằng khóa riêng (không lưu IP thô). */
  hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHmac(
      'sha256',
      secretKey(this.config.get('CONSENT_IP_HMAC_KEY'), 'CONSENT_IP_HMAC_KEY'),
    )
      .update(ip)
      .digest('hex');
  }

  async create(
    tx: Tx,
    userId: string,
    input: { role: ConsentRole; termsVersion: string },
    client: { ip: string | undefined; userAgent: string | undefined },
  ): Promise<Consent> {
    // Bản khác hiện hành: client tải lại điều khoản qua GET /consents/status.
    if (input.termsVersion !== this.currentTermsVersion()) {
      throw new AppException('CONFLICT_STALE');
    }
    // Hai request song song cùng (user, vai trò, phiên bản) xếp hàng để chặn trùng 60 giây không bị lách.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`consent:${userId}:${input.role}:${input.termsVersion}`}, 0))`,
    );
    const [recent] = await tx
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.userId, userId),
          eq(consents.role, input.role),
          eq(consents.termsVersion, input.termsVersion),
          gt(
            consents.acceptedAt,
            sql`now() - make_interval(secs => ${DEDUPE_SEC})`,
          ),
        ),
      )
      .orderBy(desc(consents.acceptedAt))
      .limit(1);
    if (recent) return toConsent(recent);
    const [row] = await tx
      .insert(consents)
      .values({
        id: uuidv7(),
        userId,
        role: input.role,
        termsVersion: input.termsVersion,
        // acceptedAt lấy `now()` của CSDL, không nhận từ client.
        ipHash: this.hashIp(client.ip),
        userAgent: client.userAgent?.slice(0, UA_MAX) ?? null,
      })
      .returning();
    return toConsent(row!);
  }

  async status(
    tx: Tx,
    userId: string,
    role: ConsentRole,
  ): Promise<ConsentStatus> {
    const current = this.currentTermsVersion();
    const [latest] = await tx
      .select({
        acceptedAt: consents.acceptedAt,
        termsVersion: consents.termsVersion,
      })
      .from(consents)
      .where(and(eq(consents.userId, userId), eq(consents.role, role)))
      // Ưu tiên dòng đúng bản hiện hành, rồi tới dòng mới nhất.
      .orderBy(
        sql`(${consents.termsVersion} = ${current}) desc`,
        desc(consents.acceptedAt),
      )
      .limit(1);
    return {
      role,
      currentTermsVersion: current,
      accepted: latest?.termsVersion === current,
      acceptedAt: latest?.acceptedAt.toISOString() ?? null,
      acceptedTermsVersion: latest?.termsVersion ?? null,
    };
  }

  /** Guard "đã đồng ý bản hiện hành": chưa → 403 CONSENT_REQUIRED kèm `details.termsVersion`. */
  async assertAccepted(userId: string, role: ConsentRole): Promise<void> {
    const s = await this.tx.run({ userId }, (t) =>
      this.status(t, userId, role),
    );
    if (!s.accepted) {
      throw new AppException('CONSENT_REQUIRED', {
        termsVersion: s.currentTermsVersion,
      });
    }
  }
}
