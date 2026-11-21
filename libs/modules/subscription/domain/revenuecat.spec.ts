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
      reason: 'type',
    });
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
    };
    expect(
      decideRevenueCatEvent(ev({ type: 'CANCELLATION' }), cur, ctx),
    ).toEqual({ kind: 'ignore', reason: 'record_only' });
    expect(
      decideRevenueCatEvent(ev({ type: 'BILLING_ISSUE' }), cur, ctx),
    ).toEqual({ kind: 'ignore', reason: 'record_only' });
  });
  it('EXPIRATION hạ về expired/free chỉ khi đang active bằng đúng kho đó', () => {
    const cur: CurrentSubscription = {
      status: 'active',
      source: 'app_store',
      lastAppliedAt: null,
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
});
