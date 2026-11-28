import { describe, expect, it } from 'vitest';
import { parseQuietWindow, quietUntil } from './quiet-hours.js';

const TZ = 'Asia/Ho_Chi_Minh';
// 21:30 → 07:00 mặc định. Giờ VN = UTC+7.
const vn = (s: string) => new Date(`${s}+07:00`);

describe('quietUntil (khung qua nửa đêm)', () => {
  it('trước 21:30 → ngoài khung', () => {
    expect(quietUntil(vn('2026-12-01T21:29:59'), TZ)).toBeNull();
    expect(quietUntil(vn('2026-12-01T12:00:00'), TZ)).toBeNull();
  });

  it('21:30 đúng: bao gồm, hẹn 07:00 sáng hôm sau', () => {
    expect(quietUntil(vn('2026-12-01T21:30:00'), TZ)).toEqual(
      vn('2026-12-02T07:00:00'),
    );
  });

  it('23:59 và qua nửa đêm đều hẹn cùng một mốc 07:00', () => {
    expect(quietUntil(vn('2026-12-01T23:59:59'), TZ)).toEqual(
      vn('2026-12-02T07:00:00'),
    );
    expect(quietUntil(vn('2026-12-02T00:00:00'), TZ)).toEqual(
      vn('2026-12-02T07:00:00'),
    );
    expect(quietUntil(vn('2026-12-02T03:15:00'), TZ)).toEqual(
      vn('2026-12-02T07:00:00'),
    );
  });

  it('06:59 còn trong khung, 07:00 đúng thì ra khỏi khung (end loại trừ)', () => {
    expect(quietUntil(vn('2026-12-02T06:59:59'), TZ)).toEqual(
      vn('2026-12-02T07:00:00'),
    );
    expect(quietUntil(vn('2026-12-02T07:00:00'), TZ)).toBeNull();
  });

  it('qua ranh giới tháng/năm', () => {
    expect(quietUntil(vn('2026-12-31T22:00:00'), TZ)).toEqual(
      vn('2027-01-01T07:00:00'),
    );
  });

  it('múi giờ khác: tính theo giờ địa phương, không theo UTC', () => {
    // 15:00 UTC = 22:00 VN (trong khung) nhưng 15:00 ở UTC (ngoài khung).
    const at = new Date('2026-12-01T15:00:00Z');
    expect(quietUntil(at, TZ)).toEqual(vn('2026-12-02T07:00:00'));
    expect(quietUntil(at, 'UTC')).toBeNull();
  });
});

describe('quietUntil (khung không qua nửa đêm)', () => {
  const w = { start: '12:00', end: '13:30' };

  it('trong khung → mốc end cùng ngày', () => {
    expect(quietUntil(vn('2026-12-01T12:00:00'), TZ, w)).toEqual(
      vn('2026-12-01T13:30:00'),
    );
    expect(quietUntil(vn('2026-12-01T13:29:00'), TZ, w)).toEqual(
      vn('2026-12-01T13:30:00'),
    );
  });

  it('ngoài khung, kể cả đúng mốc end', () => {
    expect(quietUntil(vn('2026-12-01T11:59:59'), TZ, w)).toBeNull();
    expect(quietUntil(vn('2026-12-01T13:30:00'), TZ, w)).toBeNull();
    expect(quietUntil(vn('2026-12-01T23:00:00'), TZ, w)).toBeNull();
  });
});

describe('parseQuietWindow', () => {
  it('thiếu hoặc sai dạng → mặc định 21:30–07:00', () => {
    const def = { start: '21:30', end: '07:00' };
    expect(parseQuietWindow(null)).toEqual(def);
    expect(parseQuietWindow({})).toEqual(def);
    expect(
      parseQuietWindow({ quietHours: { start: '24:00', end: '07:00' } }),
    ).toEqual(def);
    expect(
      parseQuietWindow({ quietHours: { start: '08:00', end: '08:00' } }),
    ).toEqual(def);
  });

  it('đọc khung đã lưu', () => {
    expect(
      parseQuietWindow({ quietHours: { start: '22:00', end: '06:30' } }),
    ).toEqual({ start: '22:00', end: '06:30' });
  });
});
