// Quyết định áp dụng sự kiện webhook RevenueCat lên subscriptions (US-0.8 AC2). Hàm thuần, test không cần CSDL.
import type { SubscriptionStatus } from './plan.js';

export interface RevenueCatEventInput {
  type: string;
  product_id?: string | undefined;
  store?: string | undefined;
  environment?: 'SANDBOX' | 'PRODUCTION' | undefined;
  expiration_at_ms?: number | null | undefined;
  event_timestamp_ms?: number | undefined;
}

export interface CurrentSubscription {
  status: SubscriptionStatus;
  source: string | null;
  /** `event_timestamp_ms` lớn nhất trong các sự kiện đã áp dụng của tenant; null = chưa có. */
  lastAppliedAt: Date | null;
}

export interface DecisionContext {
  now: Date;
  /** `product_id` được kích hoạt Pro (REVENUECAT_PRO_PRODUCT_IDS). Rỗng = không kích hoạt gì. */
  proProductIds: ReadonlySet<string>;
  /** Thời lượng (ngày) của sản phẩm mua một lần không có hạn. Thiếu sản phẩm = bỏ qua sự kiện. */
  nonRenewingDays: ReadonlyMap<string, number>;
  /** Production bỏ qua sự kiện SANDBOX (staging dùng project sandbox riêng). */
  ignoreSandbox: boolean;
}

export type IgnoreReason =
  | 'sandbox'
  | 'test'
  | 'type'
  | 'store'
  | 'product'
  | 'stale'
  | 'no_expiry'
  | 'expiry_in_past'
  | 'not_current_source'
  | 'record_only';

export type Decision =
  | { kind: 'ignore'; reason: IgnoreReason }
  | {
      kind: 'apply';
      planCode: 'free' | 'pro';
      status: 'active' | 'expired';
      source: 'app_store' | 'play_store';
      currentPeriodEnd: Date;
    };

const ACTIVATING = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
]);
// Chỉ ghi sự kiện: gói giữ tới hết kỳ, `EXPIRATION` mới hạ gói.
const RECORD_ONLY = new Set(['CANCELLATION', 'BILLING_ISSUE']);
const STORES = { APP_STORE: 'app_store', PLAY_STORE: 'play_store' } as const;

export function decideRevenueCatEvent(
  e: RevenueCatEventInput,
  cur: CurrentSubscription,
  ctx: DecisionContext,
): Decision {
  const ignore = (reason: IgnoreReason): Decision => ({
    kind: 'ignore',
    reason,
  });
  if (e.environment === 'SANDBOX' && ctx.ignoreSandbox)
    return ignore('sandbox');
  if (e.type === 'TEST') return ignore('test');
  if (RECORD_ONLY.has(e.type)) return ignore('record_only');
  const activating = ACTIVATING.has(e.type);
  if (!activating && e.type !== 'EXPIRATION') return ignore('type');

  const source = STORES[e.store as keyof typeof STORES];
  if (!source) return ignore('store');
  // Allowlist phía server: không tin `product_id` lạ (kể cả cho EXPIRATION, tránh hạ gói bằng sự kiện giả mạo sản phẩm).
  if (!e.product_id || !ctx.proProductIds.has(e.product_id))
    return ignore('product');
  const at =
    e.event_timestamp_ms === undefined ? null : new Date(e.event_timestamp_ms);
  if (at && cur.lastAppliedAt && at.getTime() < cur.lastAppliedAt.getTime())
    return ignore('stale');

  if (e.type === 'EXPIRATION') {
    // Chỉ hạ gói khi gói hiện tại đang trả phí bằng đúng kho này; sự kiện hết hạn của kho khác/đã thay bằng nguồn khác không đụng.
    if (cur.status !== 'active' || cur.source !== source)
      return ignore('not_current_source');
    return {
      kind: 'apply',
      planCode: 'free',
      status: 'expired',
      source,
      currentPeriodEnd:
        e.expiration_at_ms != null ? new Date(e.expiration_at_ms) : ctx.now,
    };
  }

  let end: Date | null = null;
  if (e.expiration_at_ms != null) end = new Date(e.expiration_at_ms);
  else if (e.type === 'NON_RENEWING_PURCHASE') {
    // Mua một lần không có hạn: hạn = lúc mua + thời lượng cấu hình của sản phẩm; không có cấu hình → bỏ qua.
    const days = ctx.nonRenewingDays.get(e.product_id);
    if (days) end = new Date((at ?? ctx.now).getTime() + days * 86_400_000);
  }
  if (!end) return ignore('no_expiry');
  if (end.getTime() <= ctx.now.getTime()) return ignore('expiry_in_past');
  return {
    kind: 'apply',
    planCode: 'pro',
    status: 'active',
    source,
    currentPeriodEnd: end,
  };
}
