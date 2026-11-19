import { z } from 'zod';
import { pageQuerySchema, paginatedSchema } from '@teachhub/core';
import { scheduleRuleSchema } from '@teachhub/modules/schedule';

// Sprint 2 chưa có học phí (US-1.2) và cảnh báo TT29 (US-9.3): thêm sau dưới dạng trường tùy chọn.

const classFields = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Vui lòng nhập tên lớp.')
    .max(120)
    .meta({ example: 'Toán 9A' }),
  subject: z
    .string()
    .trim()
    .min(1, 'Vui lòng nhập môn học.')
    .max(80)
    .meta({ example: 'Toán' }),
  grade: z.int().min(1).max(12).meta({ example: 9 }),
  mode: z.enum(['offline', 'online']),
  location: z.string().trim().max(200).nullish().meta({
    description: 'Bắt buộc khi `mode = offline`',
    example: 'Nhà riêng, 12 Trần Phú',
  }),
  capacity: z.int().min(1).max(500).nullish().meta({ example: 20 }),
  startDate: z.iso.date().meta({ example: '2026-12-14' }),
  endDate: z.iso
    .date()
    .nullish()
    .meta({ description: 'Bỏ trống = lớp không kỳ hạn' }),
});

type ClassDates = { startDate?: string; endDate?: string | null };

const endAfterStart = (v: ClassDates, ctx: z.RefinementCtx) => {
  if (v.startDate && v.endDate && v.endDate < v.startDate) {
    ctx.addIssue({
      code: 'custom',
      message: 'Ngày kết thúc phải sau ngày bắt đầu.',
      path: ['endDate'],
    });
  }
};

export const createClassRequestSchema = classFields
  .extend({
    id: z.uuid().optional().meta({
      description: 'UUID do client sinh (tùy chọn); thiếu thì server sinh',
    }),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'offline' && !v.location) {
      ctx.addIssue({
        code: 'custom',
        message: 'Vui lòng nhập địa điểm cho lớp học tại chỗ.',
        path: ['location'],
      });
    }
    endAfterStart(v, ctx);
  })
  .meta({
    example: {
      name: 'Toán 9A',
      subject: 'Toán',
      grade: 9,
      mode: 'offline',
      location: 'Nhà riêng, 12 Trần Phú',
      capacity: 20,
      startDate: '2026-12-14',
      endDate: null,
    },
  });
export type CreateClassRequest = z.infer<typeof createClassRequestSchema>;

/** Chỉ gửi trường đổi. Quy tắc "tại chỗ phải có địa điểm" server kiểm trên bản đã gộp. */
export const updateClassRequestSchema = classFields
  .partial()
  .superRefine(endAfterStart)
  .meta({ example: { capacity: 25 } });
export type UpdateClassRequest = z.infer<typeof updateClassRequestSchema>;

const classExample = {
  id: '019b2c3f-5e01-7c20-9b01-000000000001',
  name: 'Toán 9A',
  subject: 'Toán',
  grade: 9,
  mode: 'offline',
  location: 'Nhà riêng, 12 Trần Phú',
  capacity: 20,
  startDate: '2026-12-14',
  endDate: null,
  status: 'active',
  enrolledCount: 3,
  scheduleRules: [
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
  createdAt: '2026-12-14T09:30:00+07:00',
};

export const classSchema = z
  .object({
    id: z.uuid(),
    ...classFields.shape,
    location: z.string().nullable(),
    capacity: z.int().nullable(),
    endDate: z.iso.date().nullable(),
    status: z.enum(['active', 'archived']),
    enrolledCount: z
      .int()
      .min(0)
      .meta({ description: 'Số học viên đang ghi danh (chưa rời lớp)' }),
    scheduleRules: z.array(scheduleRuleSchema),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'Class', example: classExample });
export type Class = z.infer<typeof classSchema>;

export const classListQuerySchema = pageQuerySchema.extend({
  status: z.enum(['active', 'archived']).default('active'),
});
export type ClassListQuery = z.infer<typeof classListQuerySchema>;

export const classPageSchema = paginatedSchema(classSchema).meta({
  id: 'ClassPage',
  example: {
    items: [classExample],
    total: 1,
    page: 1,
    pageSize: 20,
  },
});
export type ClassPage = z.infer<typeof classPageSchema>;

export const rosterSchema = z
  .object({
    items: z.array(
      z.object({
        enrollmentId: z.uuid(),
        studentId: z.uuid(),
        fullName: z.string(),
        status: z.enum(['active', 'paused', 'left']),
        joinedOn: z.iso.date(),
      }),
    ),
  })
  .meta({
    id: 'Roster',
    example: {
      items: [
        {
          enrollmentId: '019b2c50-0001-7b30-8c01-000000000001',
          studentId: '019b2c4f-0001-7b30-8c01-000000000001',
          fullName: 'Nguyễn Minh Anh',
          status: 'active',
          joinedOn: '2026-12-14',
        },
        {
          enrollmentId: '019b2c50-0001-7b30-8c01-000000000002',
          studentId: '019b2c4f-0001-7b30-8c01-000000000002',
          fullName: 'Trần Gia Bảo',
          status: 'active',
          joinedOn: '2026-12-14',
        },
      ],
    },
  });
export type Roster = z.infer<typeof rosterSchema>;

export const createEnrollmentRequestSchema = z
  .object({
    studentId: z.uuid(),
    joinedOn: z.iso
      .date()
      .optional()
      .meta({ description: 'Mặc định: hôm nay (theo múi giờ tenant)' }),
  })
  .meta({ example: { studentId: '019b2c4f-0001-7b30-8c01-000000000001' } });
export type CreateEnrollmentRequest = z.infer<
  typeof createEnrollmentRequestSchema
>;

export const enrollmentSchema = z
  .object({
    id: z.uuid(),
    classId: z.uuid(),
    studentId: z.uuid(),
    joinedOn: z.iso.date(),
  })
  .meta({
    id: 'Enrollment',
    example: {
      id: '019b2c50-0001-7b30-8c01-000000000001',
      classId: '019b2c3f-5e01-7c20-9b01-000000000001',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      joinedOn: '2026-12-14',
    },
  });
export type Enrollment = z.infer<typeof enrollmentSchema>;
