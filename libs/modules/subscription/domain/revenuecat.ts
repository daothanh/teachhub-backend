// Quyết định áp dụng sự kiện webhook RevenueCat lên subscriptions (US-0.8 AC2). Hàm thuần, test không cần CSDL.
import type { SubscriptionStatus } from './plan.js';

export interface RevenueCatEventInput {
  type: string;
  product_id?: string | undefined;
  store?: string | undefined;
  environment?: 'SANDBOX' | 'PRODUCTION' | undefined;
  expiration_at_ms?: number | null | undefined;
  event_timestamp_ms?: number | undefined;
  original_transaction_id?: string | undefined;
  /** Lý do của `CANCELLATION`; `CUSTOMER_SUPPORT` = hoàn tiền, mất quyền ngay. */
  cancel_reason?: string | undefined;
}

export interface CurrentSubscription {
  status: SubscriptionStatus;
  source: string | null;
  currentPeriodEnd: Date | null;
  /** `product_id` hoặc `product_id#original_transaction_id` của kỳ đang lưu (xem `externalRefOf`). */
  externalRef: string | null;
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
  | 'no_timestamp'
  | 'timestamp_future'
  | 'expiry_in_past'
  | 'expiry_too_far'
  | 'would_shorten'
  | 'ref_mismatch'
  | 'not_current_source'
  | 'record_only'
  | 'transfer';

export type Decision =
  | { kind: 'ignore'; reason: IgnoreReason }
  | {
      kind: 'apply';
      planCode: 'free' | 'pro';
      status: 'active' | 'expired';
      source: 'app_store' | 'play_store';
      currentPeriodEnd: Date;
      externalRef: string;
    };

/** Hạn tối đa chấp nhận cho một kỳ (Pro một năm + dư): chặn `expiration_at_ms` xa bất thường. */
export const MAX_PERIOD_DAYS = 400;
const DAY_MS = 86_400_000;
const FUTURE_TOLERANCE_MS = 60 * 60_000;

/** Tham chiếu kỳ lưu ở `subscriptions.external_ref`: sản phẩm, kèm giao dịch gốc nếu có. */
export const externalRefOf = (
  productId: string,
  originalTransactionId?: string,
): string =>
  originalTransactionId ? `${productId}#${originalTransactionId}` : productId;

const ACTIVATING = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
]);
// Chỉ ghi sự kiện: gói giữ tới hết kỳ, `EXPIRATION` mới hạ gói (trừ CANCELLATION hoàn tiền, xem `REFUND_REASON`).
const RECORD_ONLY = new Set(['CANCELLATION', 'BILLING_ISSUE']);
// RevenueCat gửi CANCELLATION với lý do này khi hoàn tiền: người dùng mất quyền ngay, không chờ EXPIRATION.
const REFUND_REASON = 'CUSTOMER_SUPPORT';
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
  // TRANSFER chuyển quyền giữa app_user_id (= tenant): không tự chuyển gói giữa tenant, cần xử lý tay.
  if (e.type === 'TRANSFER') return ignore('transfer');
  const refund = e.type === 'CANCELLATION' && e.cancel_reason === REFUND_REASON;
  if (RECORD_ONLY.has(e.type) && !refund) return ignore('record_only');
  const revoking = e.type === 'EXPIRATION' || refund;
  const activating = ACTIVATING.has(e.type);
  if (!activating && !revoking) return ignore('type');

  const source = STORES[e.store as keyof typeof STORES];
  if (!source) return ignore('store');
  // Allowlist phía server: không tin `product_id` lạ (kể cả cho EXPIRATION, tránh hạ gói bằng sự kiện giả mạo sản phẩm).
  if (!e.product_id || !ctx.proProductIds.has(e.product_id))
    return ignore('product');
  // Không có mốc thời gian thì không so thứ tự được → không áp dụng; mốc ở tương lai xa sẽ chặn mọi sự kiện thật sau đó.
  if (e.event_timestamp_ms === undefined) return ignore('no_timestamp');
  const at = new Date(e.event_timestamp_ms);
  if (at.getTime() > ctx.now.getTime() + FUTURE_TOLERANCE_MS)
    return ignore('timestamp_future');
  if (cur.lastAppliedAt && at.getTime() < cur.lastAppliedAt.getTime())
    return ignore('stale');

  if (revoking) {
    // Chỉ hạ gói khi gói hiện tại đang trả phí bằng đúng kho này; sự kiện hết hạn của kho khác/đã thay bằng nguồn khác không đụng.
    if (cur.status !== 'active' || cur.source !== source)
      return ignore('not_current_source');
    // Chỉ hạ kỳ đúng sản phẩm (và giao dịch gốc nếu có) đang lưu: sự kiện hết hạn của kỳ/sản phẩm khác không đụng.
    const [curProduct, curOtid] = (cur.externalRef ?? '').split('#');
    if (
      curProduct !== e.product_id ||
      (e.original_transaction_id !== undefined &&
        curOtid !== e.original_transaction_id)
    )
      return ignore('ref_mismatch');
    return {
      kind: 'apply',
      planCode: 'free',
      status: 'expired',
      source,
      // Hoàn tiền cắt quyền ngay: `expiration_at_ms` của CANCELLATION có thể vẫn là cuối kỳ cũ.
      currentPeriodEnd:
        !refund && e.expiration_at_ms != null
          ? new Date(e.expiration_at_ms)
          : ctx.now,
      externalRef: cur.externalRef ?? e.product_id,
    };
  }

  let end: Date | null = null;
  if (e.expiration_at_ms != null) end = new Date(e.expiration_at_ms);
  else if (e.type === 'NON_RENEWING_PURCHASE') {
    // Mua một lần không có hạn: hạn = lúc mua + thời lượng cấu hình của sản phẩm; không có cấu hình → bỏ qua.
    const days = ctx.nonRenewingDays.get(e.product_id);
    if (days) end = new Date(at.getTime() + days * DAY_MS);
  }
  if (!end) return ignore('no_expiry');
  if (end.getTime() <= ctx.now.getTime()) return ignore('expiry_in_past');
  if (end.getTime() > ctx.now.getTime() + MAX_PERIOD_DAYS * DAY_MS)
    return ignore('expiry_too_far');
  // Kỳ đang trả bằng nguồn khác (chuyển khoản, kho kia) không bị rút ngắn hoặc ghi đè bởi kỳ ngắn hơn/bằng.
  const curPaid =
    (cur.status === 'active' || cur.status === 'trialing') &&
    (cur.currentPeriodEnd === null ||
      cur.currentPeriodEnd.getTime() > ctx.now.getTime());
  if (
    curPaid &&
    cur.source !== null &&
    cur.source !== source &&
    cur.currentPeriodEnd !== null &&
    end.getTime() <= cur.currentPeriodEnd.getTime()
  )
    return ignore('would_shorten');
  return {
    kind: 'apply',
    planCode: 'pro',
    status: 'active',
    source,
    currentPeriodEnd: end,
    externalRef: externalRefOf(e.product_id, e.original_transaction_id),
  };
}
