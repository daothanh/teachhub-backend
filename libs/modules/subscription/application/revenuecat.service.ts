import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException, type Env } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { decideRevenueCatEvent } from '../domain/revenuecat.js';
import type { SubscriptionStatus } from '../domain/plan.js';
import type {
  RevenueCatWebhookRequest,
  RevenueCatWebhookResult,
} from '../http/subscription.schemas.js';

/** 01/01/2100: trần hợp lý cho mốc thời gian RevenueCat, tránh `Invalid Date`. */
const MAX_EPOCH_MS = 4_102_444_800_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lý do bỏ qua đáng chú ý (cấu hình sai, dữ liệu bất thường hoặc giả mạo); loại sự kiện bình thường thì không cần ồn.
const WARN_REASONS = new Set([
  'tenant',
  'unknown_tenant',
  'product',
  'store',
  'no_expiry',
  'no_timestamp',
  'timestamp_future',
  'expiry_too_far',
  'would_shorten',
  'ref_mismatch',
  'transfer',
]);

type Begin =
  | { result: 'unknown_tenant' }
  | { result: 'duplicate' }
  | {
      result: 'ok';
      status: SubscriptionStatus;
      source: string | null;
      currentPeriodEnd: string | null;
      externalRef: string | null;
      lastAppliedAt: string | null;
    };

/**
 * Áp dụng sự kiện RevenueCat (US-0.8 AC2). Không có user nên ghi qua hàm security definer `rc_begin_event` /
 * `rc_apply_event` (khóa dòng subscription, idempotent theo event.id, một giao dịch). Log chỉ có loại sự kiện và lý do,
 * không có app_user_id/product_id/payload.
 */
@Injectable()
export class RevenueCatService {
  private readonly log = new Logger(RevenueCatService.name);

  constructor(
    private readonly tx: TxService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async handle(
    body: RevenueCatWebhookRequest,
  ): Promise<RevenueCatWebhookResult> {
    const e = body.event;
    // Khoảng hợp lý cho mốc thời gian (schema hợp đồng giữ số nguyên an toàn để oasdiff không báo breaking): ngoài khoảng → 422.
    const badTime = (
      [
        ['expiration_at_ms', e.expiration_at_ms],
        ['event_timestamp_ms', e.event_timestamp_ms],
      ] as const
    ).filter(([, v]) => v != null && (v < 0 || v > MAX_EPOCH_MS));
    if (badTime.length)
      throw new AppException(
        'VALIDATION_FAILED',
        undefined,
        Object.fromEntries(
          badTime.map(([k]) => [
            `event.${k}`,
            ['Mốc thời gian ngoài khoảng cho phép.'],
          ]),
        ),
      );
    // app_user_id không phải UUID tenant: bỏ qua, không ghi gì (không có tenant để gắn sự kiện).
    if (!UUID.test(e.app_user_id)) return this.ignored(e.type, 'tenant');
    const tenantId = e.app_user_id.toLowerCase();
    const eventAt =
      e.event_timestamp_ms === undefined
        ? null
        : new Date(e.event_timestamp_ms);
    const payload = {
      id: e.id,
      type: e.type,
      app_user_id: e.app_user_id,
      product_id: e.product_id ?? null,
      store: e.store ?? null,
      environment: e.environment ?? null,
      expiration_at_ms: e.expiration_at_ms ?? null,
      event_timestamp_ms: e.event_timestamp_ms ?? null,
      cancel_reason: e.cancel_reason ?? null,
    };
    const now = new Date();
    const nonRenewingDays = new Map<string, number>();
    for (const kv of this.config.get('REVENUECAT_NON_RENEWING_DAYS')) {
      const [id, days] = kv.split(':');
      if (id && Number.isInteger(Number(days)) && Number(days) > 0)
        nonRenewingDays.set(id, Number(days));
    }

    return this.tx.run({ userId: null }, async (t) => {
      // Cờ phiên: hàm app_private.rc_* từ chối nếu thiếu (chỉ sống trong giao dịch này).
      await t.execute(sql`select set_config('app.webhook', '1', true)`);
      const res = await t.execute<{ r: Begin }>(
        sql`select app_private.rc_begin_event(${e.id}, ${tenantId}::uuid, ${e.type}, ${eventAt?.toISOString() ?? null}::timestamptz, ${JSON.stringify(payload)}::jsonb) as r`,
      );
      const begin = res.rows[0]!.r;
      if (begin.result === 'duplicate') return { status: 'duplicate' as const };
      if (begin.result === 'unknown_tenant')
        return this.ignored(e.type, 'unknown_tenant');

      const decision = decideRevenueCatEvent(
        e,
        {
          status: begin.status,
          source: begin.source,
          currentPeriodEnd: begin.currentPeriodEnd
            ? new Date(begin.currentPeriodEnd)
            : null,
          externalRef: begin.externalRef,
          lastAppliedAt: begin.lastAppliedAt
            ? new Date(begin.lastAppliedAt)
            : null,
        },
        {
          now,
          proProductIds: new Set(this.config.get('REVENUECAT_PRO_PRODUCT_IDS')),
          nonRenewingDays,
          ignoreSandbox: this.config.get('NODE_ENV') === 'production',
        },
      );
      if (decision.kind === 'ignore')
        return this.ignored(e.type, decision.reason);
      await t.execute(
        sql`select app_private.rc_apply_event(${e.id}, ${tenantId}::uuid, ${decision.planCode}, ${decision.status}, ${decision.source}, ${decision.currentPeriodEnd.toISOString()}::timestamptz, ${decision.externalRef})`,
      );
      return { status: 'processed' as const };
    });
  }

  private ignored(type: string, reason: string): RevenueCatWebhookResult {
    if (WARN_REASONS.has(reason))
      this.log.warn(`revenuecat_event_ignored type=${type} reason=${reason}`);
    return { status: 'ignored' };
  }
}
