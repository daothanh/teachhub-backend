import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Env } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { decideRevenueCatEvent } from '../domain/revenuecat.js';
import type { SubscriptionStatus } from '../domain/plan.js';
import type {
  RevenueCatWebhookRequest,
  RevenueCatWebhookResult,
} from '../http/subscription.schemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Begin =
  | { result: 'unknown_tenant' }
  | { result: 'duplicate' }
  | {
      result: 'ok';
      status: SubscriptionStatus;
      source: string | null;
      currentPeriodEnd: string | null;
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
    };
    const now = new Date();
    const nonRenewingDays = new Map<string, number>();
    for (const kv of this.config.get('REVENUECAT_NON_RENEWING_DAYS')) {
      const [id, days] = kv.split(':');
      if (id && Number.isInteger(Number(days)) && Number(days) > 0)
        nonRenewingDays.set(id, Number(days));
    }

    return this.tx.run({ userId: null }, async (t) => {
      const res = await t.execute<{ r: Begin }>(
        sql`select app_private.rc_begin_event(${e.id}, ${tenantId}::uuid, ${e.type}, ${eventAt?.toISOString() ?? null}::timestamptz, ${JSON.stringify(payload)}::jsonb) as r`,
      );
      const begin = res.rows[0]!.r;
      if (begin.result === 'duplicate') return { status: 'duplicate' as const };
      if (begin.result === 'unknown_tenant')
        return this.ignored(e.type, 'tenant');

      const decision = decideRevenueCatEvent(
        e,
        {
          status: begin.status,
          source: begin.source,
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
        sql`select app_private.rc_apply_event(${e.id}, ${tenantId}::uuid, ${decision.planCode}, ${decision.status}, ${decision.source}, ${decision.currentPeriodEnd.toISOString()}::timestamptz, ${e.product_id ?? null})`,
      );
      return { status: 'processed' as const };
    });
  }

  private ignored(type: string, reason: string): RevenueCatWebhookResult {
    // Sản phẩm lạ/kho lạ đáng chú ý (cấu hình sai hoặc giả mạo); loại sự kiện bình thường (CANCELLATION…) thì không cần ồn.
    if (reason === 'product' || reason === 'store' || reason === 'no_expiry')
      this.log.warn(`revenuecat_event_ignored type=${type} reason=${reason}`);
    return { status: 'ignored' };
  }
}
