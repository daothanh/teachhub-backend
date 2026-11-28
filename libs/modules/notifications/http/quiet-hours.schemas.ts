import { z } from 'zod';
import { HHMM } from '../domain/quiet-hours.js';

// Giờ yên lặng toàn tenant (US-6.5 AC3), lưu ở `tenants.settings.quietHours`.

const hhmm = z.string().regex(HHMM, 'Giờ phải dạng HH:MM, từ 00:00 đến 23:59.');

export const quietHoursSchema = z
  .object({
    start: hhmm.meta({
      description: 'Bắt đầu yên lặng, giờ tenant, bao gồm mốc này',
      example: '21:30',
    }),
    end: hhmm.meta({
      description:
        'Kết thúc yên lặng, giờ tenant, không bao gồm mốc này. Nhỏ hơn `start` = khung qua nửa đêm',
      example: '07:00',
    }),
  })
  .refine((v) => v.start !== v.end, {
    message: 'Giờ bắt đầu và kết thúc không được trùng nhau.',
    path: ['end'],
  })
  .meta({
    id: 'QuietHours',
    description:
      'Khung giờ yên lặng của tenant (múi giờ của tenant). Tin không khẩn phát sinh trong khung được giữ tới `end`; tin khẩn (vắng học, đổi lịch trong 24 giờ tới) gửi ngay',
    example: { start: '21:30', end: '07:00' },
  });
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const updateQuietHoursRequestSchema = quietHoursSchema.meta({
  id: 'UpdateQuietHoursRequest',
  description: 'Thay toàn bộ khung: cả `start` và `end` đều bắt buộc',
});
export type UpdateQuietHoursRequest = z.infer<
  typeof updateQuietHoursRequestSchema
>;
