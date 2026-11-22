import {
  type CurrentSubscription,
  type DecisionContext,
  decideRevenueCatEvent,
  type RevenueCatEventInput,
} from './revenuecat.js';

const now = new Date('2027-03-01T10:00:00Z');
const day = 86_400_000;
const ctx: DecisionContext = {
  now,
  proProductIds: new Set(['pro_yearly']),
  nonRenewingDays: new Map([['pro_once', 365]]),
  ignoreSandbox: true,
};
const free: CurrentSubscription = {
  status: 'free',
  source: null,
  lastAppliedAt: null,
  currentPeriodEnd: null,
  externalRef: null,
};
const ev = (o: Partial<RevenueCatEventInput> = {}): RevenueCatEventInput => ({
  type: 'INITIAL_PURCHASE',
  product_id: 'pro_yearly',
  store: 'APP_STORE',
  environment: 'PRODUCTION',
  expiration_at_ms: now.getTime() + 365 * day,
  event_timestamp_ms: now.getTime(),
  ...o,
});

describe('decideRevenueCatEvent', () => {
  it.each(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION'])(
    '%s hợp lệ → active, nguồn theo kho, hạn theo expiration_at_ms',
    (type) => {
      expect(decideRevenueCatEvent(ev({ type }), free, ctx)).toEqual({
        kind: 'apply',
        planCode: 'pro',
        status: 'active',
        source: 'app_store',
        currentPeriodEnd: new Date(now.getTime() + 365 * day),
        externalRef: 'pro_yearly',
      });
    },
  );
  it('PLAY_STORE → play_store', () => {
    const d = decideRevenueCatEvent(ev({ store: 'PLAY_STORE' }), free, ctx);
    expect(d).toMatchObject({ kind: 'apply', source: 'play_store' });
  });
  it('product_id thiếu/lạ, rỗng allowlist → ignored (product)', () => {
    expect(
      decideRevenueCatEvent(ev({ product_id: 'khac' }), free, ctx),
    ).toEqual({ kind: 'ignore', reason: 'product' });
    expect(
      decideRevenueCatEvent(ev({ product_id: undefined }), free, ctx),
    ).toEqual({ kind: 'ignore', reason: 'product' });
    expect(
      decideRevenueCatEvent(ev(), free, { ...ctx, proProductIds: new Set() }),
    ).toEqual({ kind: 'ignore', reason: 'product' });
  });
  it('hết hạn ở quá khứ hoặc thiếu hạn → không active', () => {
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() - 1 }),
        free,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'expiry_in_past' });
    expect(
      decideRevenueCatEvent(ev({ expiration_at_ms: null }), free, ctx),
    ).toEqual({ kind: 'ignore', reason: 'no_expiry' });
    expect(
      decideRevenueCatEvent(ev({ expiration_at_ms: undefined }), free, ctx),
    ).toEqual({ kind: 'ignore', reason: 'no_expiry' });
  });
  it('NON_RENEWING_PURCHASE không có hạn: tính từ thời lượng cấu hình, không cấu hình → bỏ qua', () => {
    const e = ev({
      type: 'NON_RENEWING_PURCHASE',
      product_id: 'pro_once',
      expiration_at_ms: null,
    });
    expect(
      decideRevenueCatEvent(e, free, {
        ...ctx,
        proProductIds: new Set(['pro_once']),
      }),
    ).toMatchObject({
      kind: 'apply',
      currentPeriodEnd: new Date(now.getTime() + 365 * day),
    });
    expect(
      decideRevenueCatEvent(e, free, {
        ...ctx,
        proProductIds: new Set(['pro_once']),
        nonRenewingDays: new Map(),
      }),
    ).toEqual({ kind: 'ignore', reason: 'no_expiry' });
  });
  it('sự kiện cũ hơn sự kiện đã áp dụng → stale; bằng hoặc mới hơn thì áp dụng', () => {
    const cur = { ...free, lastAppliedAt: new Date(now.getTime()) };
    expect(
      decideRevenueCatEvent(
        ev({ event_timestamp_ms: now.getTime() - 1 }),
        cur,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'stale' });
    expect(
      decideRevenueCatEvent(ev({ event_timestamp_ms: now.getTime() }), cur, ctx)
        .kind,
    ).toBe('apply');
  });
  it('SANDBOX bị bỏ qua khi ignoreSandbox, TEST và loại lạ → ignored', () => {
    expect(
      decideRevenueCatEvent(ev({ environment: 'SANDBOX' }), free, ctx),
    ).toEqual({ kind: 'ignore', reason: 'sandbox' });
    expect(
      decideRevenueCatEvent(ev({ environment: 'SANDBOX' }), free, {
        ...ctx,
        ignoreSandbox: false,
      }).kind,
    ).toBe('apply');
    expect(decideRevenueCatEvent(ev({ type: 'TEST' }), free, ctx)).toEqual({
      kind: 'ignore',
      reason: 'test',
    });
    expect(decideRevenueCatEvent(ev({ type: 'TRANSFER' }), free, ctx)).toEqual({
      kind: 'ignore',
      reason: 'transfer',
    });
    expect(
      decideRevenueCatEvent(ev({ type: 'SUBSCRIPTION_PAUSED' }), free, ctx),
    ).toEqual({ kind: 'ignore', reason: 'type' });
    expect(decideRevenueCatEvent(ev({ store: 'STRIPE' }), free, ctx)).toEqual({
      kind: 'ignore',
      reason: 'store',
    });
  });
  it('CANCELLATION, BILLING_ISSUE chỉ ghi sự kiện, giữ gói', () => {
    const cur: CurrentSubscription = {
      status: 'active',
      source: 'app_store',
      lastAppliedAt: null,
      currentPeriodEnd: new Date(now.getTime() + 100 * day),
      externalRef: 'pro_yearly',
    };
    expect(
      decideRevenueCatEvent(ev({ type: 'CANCELLATION' }), cur, ctx),
    ).toEqual({ kind: 'ignore', reason: 'record_only' });
    expect(
      decideRevenueCatEvent(
        ev({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }),
        cur,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'record_only' });
    expect(
      decideRevenueCatEvent(ev({ type: 'BILLING_ISSUE' }), cur, ctx),
    ).toEqual({ kind: 'ignore', reason: 'record_only' });
  });
  it('CANCELLATION hoàn tiền (CUSTOMER_SUPPORT) hạ gói ngay, giữ các kiểm tra của EXPIRATION', () => {
    const cur: CurrentSubscription = {
      status: 'active',
      source: 'app_store',
      lastAppliedAt: null,
      currentPeriodEnd: new Date(now.getTime() + 100 * day),
      externalRef: 'pro_yearly#tx1',
    };
    const refund = (o: Partial<RevenueCatEventInput> = {}) =>
      ev({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', ...o });
    expect(decideRevenueCatEvent(refund(), cur, ctx)).toEqual({
      kind: 'apply',
      planCode: 'free',
      status: 'expired',
      source: 'app_store',
      // expiration_at_ms vẫn là cuối kỳ cũ nhưng quyền mất ngay.
      currentPeriodEnd: now,
      externalRef: 'pro_yearly#tx1',
    });
    expect(
      decideRevenueCatEvent(refund({ store: 'PLAY_STORE' }), cur, ctx),
    ).toEqual({ kind: 'ignore', reason: 'not_current_source' });
    expect(
      decideRevenueCatEvent(
        refund({ original_transaction_id: 'tx2' }),
        cur,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'ref_mismatch' });
    expect(
      decideRevenueCatEvent(refund({ product_id: 'khac' }), cur, ctx),
    ).toEqual({ kind: 'ignore', reason: 'product' });
    expect(
      decideRevenueCatEvent(
        refund({ event_timestamp_ms: now.getTime() - day }),
        { ...cur, lastAppliedAt: now },
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'stale' });
    expect(
      decideRevenueCatEvent(
        refund({ event_timestamp_ms: undefined }),
        cur,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'no_timestamp' });
  });
  it('EXPIRATION hạ về expired/free chỉ khi đang active bằng đúng kho đó', () => {
    const cur: CurrentSubscription = {
      status: 'active',
      source: 'app_store',
      lastAppliedAt: null,
      currentPeriodEnd: new Date(now.getTime() + 100 * day),
      externalRef: 'pro_yearly',
    };
    const e = ev({ type: 'EXPIRATION', expiration_at_ms: now.getTime() });
    expect(decideRevenueCatEvent(e, cur, ctx)).toMatchObject({
      kind: 'apply',
      planCode: 'free',
      status: 'expired',
    });
    expect(
      decideRevenueCatEvent(e, { ...cur, source: 'bank_transfer' }, ctx),
    ).toEqual({ kind: 'ignore', reason: 'not_current_source' });
    expect(
      decideRevenueCatEvent(
        e,
        { ...cur, status: 'trialing', source: null },
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'not_current_source' });
  });

  it('thiếu event_timestamp_ms → ignored cho sự kiện kích hoạt và EXPIRATION; mốc ở tương lai xa → ignored', () => {
    const cur: CurrentSubscription = {
      status: 'active',
      source: 'app_store',
      lastAppliedAt: null,
      currentPeriodEnd: new Date(now.getTime() + day),
      externalRef: 'pro_yearly',
    };
    expect(
      decideRevenueCatEvent(ev({ event_timestamp_ms: undefined }), free, ctx),
    ).toEqual({ kind: 'ignore', reason: 'no_timestamp' });
    expect(
      decideRevenueCatEvent(
        ev({ type: 'EXPIRATION', event_timestamp_ms: undefined }),
        cur,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'no_timestamp' });
    expect(
      decideRevenueCatEvent(
        ev({ event_timestamp_ms: now.getTime() + 2 * day }),
        free,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'timestamp_future' });
  });
  it('hạn > 400 ngày → ignored', () => {
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 401 * day }),
        free,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'expiry_too_far' });
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 400 * day }),
        free,
        ctx,
      ).kind,
    ).toBe('apply');
  });
  it('kỳ đang trả bằng nguồn khác không bị rút ngắn/ghi đè bởi hạn ngắn hơn hoặc bằng; dài hơn thì được', () => {
    const bank: CurrentSubscription = {
      status: 'active',
      source: 'bank_transfer',
      lastAppliedAt: null,
      currentPeriodEnd: new Date(now.getTime() + 300 * day),
      externalRef: null,
    };
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 30 * day }),
        bank,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'would_shorten' });
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 300 * day }),
        bank,
        ctx,
      ),
    ).toEqual({ kind: 'ignore', reason: 'would_shorten' });
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 301 * day }),
        bank,
        ctx,
      ).kind,
    ).toBe('apply');
    // cùng kho: gia hạn/đổi gói được phép dù ngắn hơn; kỳ đã hết hạn hoặc dùng thử (nguồn null) thì mua mới ghi đè
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 30 * day }),
        { ...bank, source: 'app_store' },
        ctx,
      ).kind,
    ).toBe('apply');
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 30 * day }),
        { ...bank, currentPeriodEnd: new Date(now.getTime() - 1) },
        ctx,
      ).kind,
    ).toBe('apply');
    expect(
      decideRevenueCatEvent(
        ev({ expiration_at_ms: now.getTime() + 30 * day }),
        { ...bank, status: 'trialing', source: null },
        ctx,
      ).kind,
    ).toBe('apply');
  });
  it('EXPIRATION chỉ hạ khi product_id (và original_transaction_id nếu có) khớp kỳ đang lưu', () => {
    const cur: CurrentSubscription = {
      status: 'active',
      source: 'app_store',
      lastAppliedAt: null,
      currentPeriodEnd: new Date(now.getTime() + day),
      externalRef: 'pro_yearly#tx1',
    };
    const exp = (o: Partial<RevenueCatEventInput>) =>
      decideRevenueCatEvent(ev({ type: 'EXPIRATION', ...o }), cur, {
        ...ctx,
        proProductIds: new Set(['pro_yearly', 'pro_other']),
      });
    expect(exp({ original_transaction_id: 'tx1' }).kind).toBe('apply');
    expect(exp({}).kind).toBe('apply');
    expect(exp({ original_transaction_id: 'tx2' })).toEqual({
      kind: 'ignore',
      reason: 'ref_mismatch',
    });
    expect(exp({ product_id: 'pro_other' })).toEqual({
      kind: 'ignore',
      reason: 'ref_mismatch',
    });
  });
  it('kích hoạt lưu externalRef kèm original_transaction_id', () => {
    expect(
      decideRevenueCatEvent(ev({ original_transaction_id: 'tx9' }), free, ctx),
    ).toMatchObject({ externalRef: 'pro_yearly#tx9' });
  });
});
