import { z } from 'zod';
import { sessionStatusSchema } from '@teachhub/modules/schedule';

/** Bốn trạng thái điểm danh (Spec §4 bảng `attendance`). Chưa điểm danh = không có dòng (`null` khi đọc). */
export const attendanceStatusSchema = z
  .enum(['present', 'late', 'excused', 'unexcused'])
  .meta({
    id: 'AttendanceStatus',
    description:
      'present = có mặt, late = đi muộn, excused = vắng có phép, unexcused = vắng không phép',
  });

const note = z.string().trim().max(500).nullable();

const summarySchema = z
  .object({
    present: z.int().min(0),
    late: z.int().min(0),
    excused: z.int().min(0),
    unexcused: z.int().min(0),
  })
  .meta({ id: 'AttendanceSummary' });

// ---- GET /sessions/{id}/attendance ----

export const attendanceItemSchema = z
  .object({
    studentId: z.uuid(),
    fullName: z.string(),
    status: attendanceStatusSchema.nullable().meta({
      description: '`null` = chưa điểm danh; app hiểu là "Có mặt" khi mở màn',
    }),
    note: z.string().nullable(),
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'AttendanceItem' });

export const sessionAttendanceSchema = z
  .object({
    sessionId: z.uuid(),
    classId: z.uuid(),
    className: z.string(),
    startsAt: z.iso.datetime({ offset: true }),
    sessionStatus: sessionStatusSchema,
    canEdit: z.boolean().meta({
      description: 'false khi buổi quá 7 ngày tính theo ngày buổi học: chỉ xem',
    }),
    serverTime: z.iso.datetime({ offset: true }).meta({
      description:
        'Giờ máy chủ lúc trả lời; app dùng để hiệu chỉnh lệch đồng hồ thiết bị',
    }),
    items: z
      .array(attendanceItemSchema)
      .meta({ description: 'Học viên đang học của lớp tại thời điểm buổi' }),
    summary: summarySchema,
  })
  .meta({
    id: 'SessionAttendance',
    example: {
      sessionId: '019b2c41-0001-7a10-8a01-000000000001',
      classId: '019b2c3f-5e01-7c20-9b01-000000000001',
      className: 'Toán 9A',
      startsAt: '2026-12-15T18:00:00+07:00',
      sessionStatus: 'taught',
      canEdit: true,
      serverTime: '2026-12-15T19:40:00+07:00',
      items: [
        {
          studentId: '019b2c42-0001-7a10-8a01-000000000001',
          fullName: 'Nguyễn Minh An',
          status: 'present',
          note: null,
          updatedAt: '2026-12-15T19:35:00+07:00',
        },
        {
          studentId: '019b2c42-0001-7a10-8a01-000000000002',
          fullName: 'Trần Bảo Châu',
          status: 'unexcused',
          note: null,
          updatedAt: '2026-12-15T19:35:00+07:00',
        },
      ],
      summary: { present: 1, late: 0, excused: 0, unexcused: 1 },
    },
  });
export type SessionAttendance = z.infer<typeof sessionAttendanceSchema>;

// ---- POST /attendance/sync ----

export const attendanceMutationSchema = z.object({
  clientMutationId: z.uuid().meta({
    description: 'UUID do app sinh, duy nhất toàn cục; gửi lặp → `duplicate`',
  }),
  studentId: z.uuid(),
  status: attendanceStatusSchema,
  note,
  clientUpdatedAt: z.iso
    .datetime({ offset: true })
    .meta({
      description: 'Giờ thiết bị lúc sửa; khóa để chọn bản sau cùng (LWW)',
    }),
});

export const attendanceSyncRequestSchema = z
  .object({
    deviceId: z.uuid(),
    deviceTime: z.iso.datetime({ offset: true }).meta({
      description:
        'Giờ thiết bị lúc gửi; server so với giờ của mình để hiệu chỉnh lệch đồng hồ',
    }),
    sessionId: z.uuid(),
    markSessionTaught: z.boolean().default(false).meta({
      description:
        'true = chuyển buổi sang "đã dạy"; học viên không có trong `mutations` được hiểu là "Có mặt"',
    }),
    mutations: z.array(attendanceMutationSchema).min(1).max(500),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.mutations.forEach((m, i) => {
      if (seen.has(m.clientMutationId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'clientMutationId bị lặp trong lô.',
          path: ['mutations', i, 'clientMutationId'],
        });
      }
      seen.add(m.clientMutationId);
    });
  })
  .meta({
    id: 'AttendanceSyncRequest',
    description:
      'Một lô cho một buổi; buổi khác thì gửi lô khác. Dùng chung cho lưu online, đồng bộ offline và sửa sau.',
    example: {
      deviceId: '019b2c50-0001-7a10-8a01-0000000000d1',
      deviceTime: '2026-12-15T19:02:11+07:00',
      sessionId: '019b2c41-0001-7a10-8a01-000000000001',
      markSessionTaught: true,
      mutations: [
        {
          clientMutationId: '019b2c51-0001-7a10-8a01-000000000001',
          studentId: '019b2c42-0001-7a10-8a01-000000000002',
          status: 'unexcused',
          note: null,
          clientUpdatedAt: '2026-12-15T19:01:55+07:00',
        },
        {
          clientMutationId: '019b2c51-0001-7a10-8a01-000000000002',
          studentId: '019b2c42-0001-7a10-8a01-000000000003',
          status: 'excused',
          note: 'Phụ huynh gọi báo ốm',
          clientUpdatedAt: '2026-12-15T19:01:55+07:00',
        },
      ],
    },
  });
export type AttendanceSyncRequest = z.infer<typeof attendanceSyncRequestSchema>;

export const attendanceMutationResultSchema = z
  .object({
    clientMutationId: z.uuid(),
    result: z.enum(['applied', 'duplicate', 'stale', 'rejected']).meta({
      description:
        'applied = đã ghi; duplicate = đã nhận trước đó; stale = bản trên server mới hơn (client tải lại bằng GET); rejected = không ghi, xem `errorCode`',
    }),
    errorCode: z
      .enum([
        'ATTENDANCE_EDIT_WINDOW_CLOSED',
        'READONLY_PLAN_LIMIT',
        'NOT_FOUND',
      ])
      .optional()
      .meta({
        description:
          'Chỉ có khi `rejected`. NOT_FOUND: học viên không thuộc lớp của buổi.',
      }),
  })
  .meta({ id: 'AttendanceMutationResult' });

export const attendanceSyncResultSchema = z
  .object({
    sessionId: z.uuid(),
    sessionStatus: sessionStatusSchema,
    results: z
      .array(attendanceMutationResultSchema)
      .meta({ description: 'Đúng thứ tự và số phần tử của `mutations`' }),
    summary: summarySchema,
    parentsToNotify: z.int().min(0).meta({
      description:
        'Số phụ huynh sẽ nhận báo vắng từ lô này (gửi bất đồng bộ qua outbox)',
    }),
  })
  .meta({
    id: 'AttendanceSyncResult',
    example: {
      sessionId: '019b2c41-0001-7a10-8a01-000000000001',
      sessionStatus: 'taught',
      results: [
        {
          clientMutationId: '019b2c51-0001-7a10-8a01-000000000001',
          result: 'applied',
        },
        {
          clientMutationId: '019b2c51-0001-7a10-8a01-000000000002',
          result: 'rejected',
          errorCode: 'ATTENDANCE_EDIT_WINDOW_CLOSED',
        },
      ],
      summary: { present: 16, late: 0, excused: 1, unexcused: 1 },
      parentsToNotify: 1,
    },
  });
export type AttendanceSyncResult = z.infer<typeof attendanceSyncResultSchema>;

// ---- GET /sessions/{id}/attendance/history ----

const stateSchema = z.object({
  status: attendanceStatusSchema,
  note: z.string().nullable(),
});

export const attendanceHistoryItemSchema = z
  .object({
    id: z.uuid(),
    studentId: z.uuid(),
    studentName: z.string(),
    changedByName: z.string().nullable(),
    changedAt: z.iso.datetime({ offset: true }),
    before: stateSchema
      .nullable()
      .meta({ description: '`null` = lần điểm danh đầu' }),
    after: stateSchema,
  })
  .meta({ id: 'AttendanceHistoryItem' });

export const attendanceHistorySchema = z
  .object({
    items: z.array(attendanceHistoryItemSchema).max(500).meta({
      description: 'Mới nhất trước; tối đa 500 dòng, không phân trang',
    }),
  })
  .meta({
    id: 'AttendanceHistory',
    example: {
      items: [
        {
          id: '019b2c60-0001-7a10-8a01-000000000001',
          studentId: '019b2c42-0001-7a10-8a01-000000000002',
          studentName: 'Trần Bảo Châu',
          changedByName: 'Cô Lan',
          changedAt: '2026-12-15T19:50:00+07:00',
          before: { status: 'unexcused', note: null },
          after: { status: 'present', note: 'Đến trễ, nhầm trạng thái' },
        },
      ],
    },
  });
export type AttendanceHistory = z.infer<typeof attendanceHistorySchema>;
