import { describe, expect, it } from 'vitest';
import { quietHoursSchema } from './quiet-hours.schemas.js';

describe('quietHoursSchema', () => {
  it('nhận HH:MM hợp lệ, kể cả khung qua nửa đêm và ranh giới', () => {
    for (const v of [
      { start: '21:30', end: '07:00' },
      { start: '00:00', end: '23:59' },
      { start: '08:00', end: '09:00' },
    ]) {
      expect(quietHoursSchema.safeParse(v).success).toBe(true);
    }
  });

  it('từ chối giờ sai dạng, ngoài 00:00–23:59, trùng nhau, thiếu trường', () => {
    for (const v of [
      { start: '24:00', end: '07:00' },
      { start: '21:60', end: '07:00' },
      { start: '9:00', end: '07:00' },
      { start: '21:30', end: '7' },
      { start: '08:00', end: '08:00' },
      { start: '21:30' },
    ]) {
      expect(quietHoursSchema.safeParse(v).success).toBe(false);
    }
  });
});
