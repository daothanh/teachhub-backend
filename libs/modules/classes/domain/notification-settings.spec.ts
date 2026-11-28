import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  mergeNotificationSettings,
} from './notification-settings.js';

describe('mergeNotificationSettings', () => {
  it('thiếu dữ liệu → bật hết', () => {
    expect(mergeNotificationSettings(null)).toEqual(
      DEFAULT_NOTIFICATION_SETTINGS,
    );
    expect(mergeNotificationSettings({})).toEqual(
      DEFAULT_NOTIFICATION_SETTINGS,
    );
  });

  it('patch đè đúng khóa, giữ khóa còn lại', () => {
    const cur = mergeNotificationSettings(null, { absence: false });
    expect(cur.absence).toBe(false);
    const next = mergeNotificationSettings(cur, { invoice: false });
    expect(next).toEqual({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      absence: false,
      invoice: false,
    });
  });

  it('bật lại khóa đã tắt', () => {
    const off = mergeNotificationSettings(null, { dunning: false });
    expect(mergeNotificationSettings(off, { dunning: true }).dunning).toBe(
      true,
    );
  });

  it('bỏ qua khóa lạ và giá trị không phải boolean trong dữ liệu đã lưu', () => {
    expect(mergeNotificationSettings({ absence: 'x', foo: false })).toEqual(
      DEFAULT_NOTIFICATION_SETTINGS,
    );
  });
});
