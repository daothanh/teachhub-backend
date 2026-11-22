import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { EventsProcessor } from './events.processor.js';

// Các index module nạp CoreModule (đọc env lúc import): chỉ cần hằng tên sự kiện và kiểu notifier.
vi.mock('@teachhub/core', () => ({ captureJobFailure: vi.fn() }));
vi.mock('@teachhub/modules/billing', () => ({
  BILLING_DRAFTS_READY: 'billing_drafts_ready',
  INVOICE_ISSUED: 'invoice_issued',
  PAYMENT_RECORDED: 'payment_recorded',
  PAYMENT_REMINDER: 'payment_reminder',
}));
vi.mock('@teachhub/modules/subscription', () => ({
  SUBSCRIPTION_EXPIRING: 'subscription_expiring',
  SUBSCRIPTION_ACTIVATED: 'subscription_activated',
}));
vi.mock('@teachhub/modules/schedule', () => ({
  SCHEDULE_CHANGED: 'schedule_changed',
}));
vi.mock('@teachhub/modules/notifications', () => ({
  BillingReadyNotifier: class {},
  InvoiceIssuedNotifier: class {},
  PaymentRecordedNotifier: class {},
  PaymentReminderNotifier: class {},
  SubscriptionNotifier: class {},
}));

const job = (name: string, data: unknown) => ({ name, data }) as Job;

describe('EventsProcessor: phân loại sự kiện outbox', () => {
  const make = () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    const issued = vi.fn().mockResolvedValue(undefined);
    const paid = vi.fn().mockResolvedValue(undefined);
    const reminder = vi.fn().mockResolvedValue(undefined);
    const expiring = vi.fn().mockResolvedValue(undefined);
    const activated = vi.fn().mockResolvedValue(undefined);
    return {
      handle,
      issued,
      paid,
      reminder,
      expiring,
      activated,
      p: new EventsProcessor(
        { handle } as never,
        { handle: issued } as never,
        { handle: paid } as never,
        { handle: reminder } as never,
        { handleExpiring: expiring, handleActivated: activated } as never,
      ),
    };
  };

  it('billing_drafts_ready → BillingReadyNotifier.handle với nguyên dữ liệu job', async () => {
    const { p, handle } = make();
    const data = { eventId: 'e', tenantId: 't', payload: {} };
    await p.process(job('billing_drafts_ready', data));
    expect(handle).toHaveBeenCalledExactlyOnceWith(data);
  });

  it('invoice_issued → InvoiceIssuedNotifier.handle, không đụng BillingReadyNotifier', async () => {
    const { p, handle, issued } = make();
    const data = { eventId: 'e', tenantId: 't', payload: {} };
    await p.process(job('invoice_issued', data));
    expect(issued).toHaveBeenCalledExactlyOnceWith(data);
    expect(handle).not.toHaveBeenCalled();
  });

  it('payment_recorded → PaymentRecordedNotifier.handle, không đụng hai notifier kia', async () => {
    const { p, handle, issued, paid } = make();
    const data = { eventId: 'e', tenantId: 't', payload: {} };
    await p.process(job('payment_recorded', data));
    expect(paid).toHaveBeenCalledExactlyOnceWith(data);
    expect(handle).not.toHaveBeenCalled();
    expect(issued).not.toHaveBeenCalled();
  });

  it('payment_reminder → PaymentReminderNotifier.handle, không đụng notifier tiền khác', async () => {
    const { p, paid, reminder } = make();
    const data = { eventId: 'e', tenantId: 't', payload: {} };
    await p.process(job('payment_reminder', data));
    expect(reminder).toHaveBeenCalledExactlyOnceWith(data);
    expect(paid).not.toHaveBeenCalled();
  });

  it('subscription_expiring / subscription_activated → SubscriptionNotifier tương ứng, không đụng notifier khác', async () => {
    const { p, expiring, activated, reminder } = make();
    const data = { eventId: 'e', tenantId: 't', payload: {} };
    await p.process(job('subscription_expiring', data));
    expect(expiring).toHaveBeenCalledExactlyOnceWith(data);
    expect(activated).not.toHaveBeenCalled();
    await p.process(job('subscription_activated', data));
    expect(activated).toHaveBeenCalledExactlyOnceWith(data);
    expect(reminder).not.toHaveBeenCalled();
  });

  it('schedule_changed → chỉ ghi log, không gọi notifier', async () => {
    const { p, handle } = make();
    await p.process(
      job('schedule_changed', {
        eventId: 'e',
        tenantId: 't',
        payload: { change: 'cancelled', sessionId: 's' },
      }),
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it('loại lạ → từ chối để job vào hàng failed', async () => {
    const { p } = make();
    await expect(p.process(job('unknown_event', {}))).rejects.toThrow(
      /unknown_event/,
    );
  });
});
