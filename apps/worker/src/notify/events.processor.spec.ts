import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { EventsProcessor } from './events.processor.js';

// Các index module nạp CoreModule (đọc env lúc import): chỉ cần hằng tên sự kiện và kiểu notifier.
vi.mock('@teachhub/modules/billing', () => ({
  BILLING_DRAFTS_READY: 'billing_drafts_ready',
}));
vi.mock('@teachhub/modules/schedule', () => ({
  SCHEDULE_CHANGED: 'schedule_changed',
}));
vi.mock('@teachhub/modules/notifications', () => ({
  BillingReadyNotifier: class {},
}));

const job = (name: string, data: unknown) => ({ name, data }) as Job;

describe('EventsProcessor: phân loại sự kiện outbox', () => {
  const make = () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    return { handle, p: new EventsProcessor({ handle } as never) };
  };

  it('billing_drafts_ready → BillingReadyNotifier.handle với nguyên dữ liệu job', async () => {
    const { p, handle } = make();
    const data = { eventId: 'e', tenantId: 't', payload: {} };
    await p.process(job('billing_drafts_ready', data));
    expect(handle).toHaveBeenCalledExactlyOnceWith(data);
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
