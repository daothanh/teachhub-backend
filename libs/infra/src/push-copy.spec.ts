import { describe, expect, it, vi } from 'vitest';
import { FirebasePushSender } from './push.js';
import { PUSH_COPY, pushCopyFor, type PushType } from './push-copy.js';

// Mọi loại thông báo đang gửi push (TYPE_* trong notifications/application).
const SENT_TYPES = [
  'student_absent',
  'student_absent_correction',
  'student_absence_reported',
  'billing_ready',
  'invoice_issued',
  'payment_recorded',
  'payment_reminder',
  'payment_claim_created',
  'payment_claim_rejected',
  'schedule_changed',
  'subscription_expiring',
  'subscription_activated',
  'tax_threshold_alert',
];

describe('pushCopyFor', () => {
  it('mọi loại đang dùng đều có tiêu đề, nội dung và kênh', () => {
    for (const t of SENT_TYPES) {
      const c = PUSH_COPY[t as PushType];
      expect(c, t).toBeDefined();
      expect(c!.title.length).toBeGreaterThan(0);
      expect(c!.body).toContain('DayHoc');
      expect(['attendance', 'billing', 'general']).toContain(c!.channelId);
    }
  });

  it('chữ chung không chứa chữ số (số tiền, ngày) nào', () => {
    for (const c of [...Object.values(PUSH_COPY), pushCopyFor('lạ')])
      expect(`${c.title} ${c.body}`).not.toMatch(/[\d{}$]/);
  });

  it('loại lạ dùng chuỗi mặc định chung', () => {
    expect(pushCopyFor('khong_biet')).toMatchObject({
      title: 'DayHoc',
      channelId: 'general',
    });
  });
});

describe('FirebasePushSender payload', () => {
  const build = async (urgent: boolean) => {
    const sendEach = vi.fn().mockResolvedValue({
      responses: [{ success: true, messageId: 'm1' }],
    });
    const sender = Object.create(
      FirebasePushSender.prototype,
    ) as FirebasePushSender;
    (sender as unknown as { messaging: unknown }).messaging = { sendEach };
    await sender.send([
      {
        token: 't',
        urgent,
        copy: pushCopyFor('student_absent'),
        data: { notificationId: 'n1', type: 'student_absent' },
      },
    ]);
    return sendEach.mock.calls[0]![0][0];
  };

  it('có khối notification, giữ data, APNs alert + sound, kênh Android', async () => {
    const m = await build(true);
    expect(m.notification).toEqual({
      title: 'Thông báo vắng học',
      body: expect.stringContaining('DayHoc'),
    });
    expect(m.data).toEqual({ notificationId: 'n1', type: 'student_absent' });
    expect(m.apns.payload.aps.sound).toBe('default');
    expect(m.apns.headers['apns-push-type']).toBe('alert');
    expect(m.android).toEqual({
      priority: 'high',
      notification: { channelId: 'attendance', visibility: 'private' },
    });
  });

  it('tin thường: Android priority normal', async () => {
    expect((await build(false)).android.priority).toBe('normal');
  });
});
