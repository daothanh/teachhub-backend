import { z } from 'zod';

/** Giờ `HH:mm` theo múi giờ của tenant (mặc định Asia/Ho_Chi_Minh). */
const startTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Giờ bắt đầu phải có dạng HH:mm.')
  .meta({ example: '18:00' });

export const scheduleRuleInputSchema = z.object({
  weekday: z
    .int()
    .min(1)
    .max(7)
    .meta({ description: 'ISO 8601: 1 = Thứ Hai … 7 = Chủ Nhật', example: 2 }),
  startTime,
  durationMin: z.int().min(15).max(480).meta({ example: 90 }),
});
export type ScheduleRuleInput = z.infer<typeof scheduleRuleInputSchema>;

export const scheduleRuleSchema = scheduleRuleInputSchema
  .extend({ id: z.uuid() })
  .meta({
    id: 'ScheduleRule',
    example: {
      id: '019b2c40-1a01-7a10-8a01-000000000001',
      weekday: 2,
      startTime: '18:00',
      durationMin: 90,
    },
  });
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

export const putScheduleRulesRequestSchema = z
  .object({
    rules: z
      .array(scheduleRuleInputSchema)
      .max(14)
      .meta({ description: 'Toàn bộ bộ quy tắc mới; mảng rỗng = bỏ lịch lặp' }),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.rules.forEach((r, i) => {
      const key = `${r.weekday} ${r.startTime}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Quy tắc trùng thứ và giờ bắt đầu.',
          path: ['rules', i, 'startTime'],
        });
      }
      seen.add(key);
      const [h, m] = r.startTime.split(':').map(Number);
      if ((h ?? 0) * 60 + (m ?? 0) + r.durationMin > 24 * 60) {
        ctx.addIssue({
          code: 'custom',
          message: 'Buổi học không được kéo qua 24:00.',
          path: ['rules', i, 'durationMin'],
        });
      }
    });
  })
  .meta({
    example: {
      rules: [
        { weekday: 2, startTime: '18:00', durationMin: 90 },
        { weekday: 4, startTime: '18:00', durationMin: 90 },
      ],
    },
  });
export type PutScheduleRulesRequest = z.infer<
  typeof putScheduleRulesRequestSchema
>;

export const scheduleRulesResultSchema = z
  .object({
    rules: z.array(scheduleRuleSchema),
    sessionsGenerated: z.int().min(0),
    sessionsRemoved: z.int().min(0),
  })
  .meta({
    id: 'ScheduleRulesResult',
    example: {
      rules: [
        {
          id: '019b2c40-1a01-7a10-8a01-000000000001',
          weekday: 2,
          startTime: '18:00',
          durationMin: 90,
        },
        {
          id: '019b2c40-1a01-7a10-8a01-000000000002',
          weekday: 4,
          startTime: '18:00',
          durationMin: 90,
        },
      ],
      sessionsGenerated: 16,
      sessionsRemoved: 0,
    },
  });
export type ScheduleRulesResult = z.infer<typeof scheduleRulesResultSchema>;

export const sessionStatusSchema = z.enum(['planned', 'taught', 'cancelled']);

export const sessionSchema = z
  .object({
    id: z.uuid(),
    classId: z.uuid(),
    className: z.string(),
    sessionDate: z.iso.date(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    status: sessionStatusSchema,
    isMakeup: z.boolean(),
    cancelReason: z.string().max(300).nullable().meta({
      description: 'Lý do hủy; null nếu buổi chưa hủy hoặc không nhập lý do',
    }),
    makeupOf: z.uuid().nullable().meta({
      description: 'Id buổi gốc nếu đây là buổi bù; null nếu không phải',
    }),
  })
  .meta({ id: 'Session' });

export const sessionsQuerySchema = z
  .object({
    from: z.iso.date().meta({ example: '2026-12-14' }),
    to: z.iso.date().meta({ example: '2026-12-20' }),
    classId: z.uuid().optional(),
  })
  .superRefine((q, ctx) => {
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (days < 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Ngày kết thúc không được trước ngày bắt đầu.',
        path: ['to'],
      });
    } else if (days > 62) {
      ctx.addIssue({
        code: 'custom',
        message: 'Chỉ xem tối đa 62 ngày mỗi lần.',
        path: ['to'],
      });
    }
  });
export type SessionsQuery = z.infer<typeof sessionsQuerySchema>;

export const sessionsResponseSchema = z
  .object({ items: z.array(sessionSchema) })
  .meta({
    id: 'SessionList',
    example: {
      items: [
        {
          id: '019b2c41-0001-7a10-8a01-000000000001',
          classId: '019b2c3f-5e01-7c20-9b01-000000000001',
          className: 'Toán 9A',
          sessionDate: '2026-12-15',
          startsAt: '2026-12-15T18:00:00+07:00',
          endsAt: '2026-12-15T19:30:00+07:00',
          status: 'planned',
          isMakeup: false,
          cancelReason: null,
          makeupOf: null,
        },
        {
          id: '019b2c41-0001-7a10-8a01-000000000002',
          classId: '019b2c3f-5e01-7c20-9b01-000000000001',
          className: 'Toán 9A',
          sessionDate: '2026-12-17',
          startsAt: '2026-12-17T18:00:00+07:00',
          endsAt: '2026-12-17T19:30:00+07:00',
          status: 'planned',
          isMakeup: false,
          cancelReason: null,
          makeupOf: null,
        },
      ],
    },
  });
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

const reasonSchema = z.string().trim().max(300).optional().meta({
  description: 'Lý do, hiện cho phụ huynh trong thông báo; tùy chọn',
  example: 'Cô bận việc đột xuất',
});

const sessionTimeFields = z.object({
  startsAt: z.iso.datetime({ offset: true }).meta({
    description: 'Giờ bắt đầu mới, phải ở tương lai',
    example: '2026-12-18T18:00:00+07:00',
  }),
  durationMin: z.int().min(15).max(480).optional().meta({
    description: 'Thời lượng mới; bỏ trống = giữ thời lượng buổi gốc',
  }),
});

export const rescheduleSessionRequestSchema = sessionTimeFields
  .extend({ reason: reasonSchema })
  .meta({
    id: 'RescheduleSessionRequest',
    example: {
      startsAt: '2026-12-18T18:00:00+07:00',
      reason: 'Cô bận việc đột xuất',
    },
  });
export type RescheduleSessionRequest = z.infer<
  typeof rescheduleSessionRequestSchema
>;

export const cancelSessionRequestSchema = z
  .object({ reason: reasonSchema })
  .meta({
    id: 'CancelSessionRequest',
    example: { reason: 'Cô bận việc đột xuất' },
  });
export type CancelSessionRequest = z.infer<typeof cancelSessionRequestSchema>;

export const makeupSessionRequestSchema = sessionTimeFields.meta({
  id: 'MakeupSessionRequest',
  example: { startsAt: '2026-12-20T18:00:00+07:00' },
});
export type MakeupSessionRequest = z.infer<typeof makeupSessionRequestSchema>;
export type Session = z.infer<typeof sessionSchema>;
