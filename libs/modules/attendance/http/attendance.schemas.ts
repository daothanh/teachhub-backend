import { z } from 'zod';
import { cursorPageSchema, cursorQuerySchema } from '@teachhub/core';
import { MUTATION_ERROR_CODES } from './mutation-error-codes.js';
import { sessionStatusSchema } from '@teachhub/modules/schedule';

/** Bốn trạng thái điểm danh (Spec §4 bảng `attendance`). Chưa điểm danh = không có dòng (`null` khi đọc). */
export const attendanceStatusSchema = z
  .enum(['present', 'late', 'excused', 'unexcused'])
  .meta({
    id: 'AttendanceStatus',
    description:
      'present = có mặt, late = đi muộn, excused = vắng có phép, unexcused = vắng không phép',
  });

/** Ghi chú dùng chung cho item và mutation. */
const noteSchema = z.string().trim().max(500).nullable();

const lwwTime = z.iso.datetime({ offset: true });

const summarySchema = z
  .object({
    present: z.int().min(0),
    late: z.int().min(0),
    excused: z.int().min(0),
    unexcused: z.int().min(0),
  })
  .meta({ id: 'AttendanceSummary' });

/** Bản đang lưu trên server; `clientUpdatedAt` là mốc LWW đã hiệu chỉnh lệch đồng hồ. */
export const attendanceCurrentSchema = z
  .object({
    status: attendanceStatusSchema,
    note: noteSchema,
    clientUpdatedAt: lwwTime,
    recordedByName: z.string().optional(),
  })
  .meta({ id: 'AttendanceCurrent' });

// ---- GET /sessions/{id}/attendance ----

export const attendanceItemSchema = z
  .object({
    studentId: z.uuid(),
    fullName: z.string(),
    status: attendanceStatusSchema.nullable().meta({
      description: '`null` = chưa điểm danh; app hiểu là "Có mặt" khi mở màn',
    }),
    note: noteSchema,
    clientUpdatedAt: lwwTime.nullable().meta({
      description:
        'Mốc LWW của bản đang lưu, đã hiệu chỉnh lệch đồng hồ. Mutation chỉ thắng khi `clientUpdatedAt` của nó LỚN HƠN (`>`) mốc này; bằng nhau → `stale`.',
    }),
    syncedAt: lwwTime.nullable().meta({
      description: 'Giờ server nhận bản đang lưu',
    }),
  })
  .meta({ id: 'AttendanceItem' });

export const sessionAttendanceSchema = z
  .object({
    sessionId: z.uuid(),
    classId: z.uuid(),
    className: z.string(),
    sessionDate: z.iso.date().meta({
      description:
        'Ngày buổi học theo múi giờ của tenant; cửa sổ 7 ngày tính theo ngày này',
    }),
    startsAt: z.iso.datetime({ offset: true }),
    sessionStatus: sessionStatusSchema,
    canEdit: z.boolean().meta({
      description:
        'false khi buổi quá 7 ngày theo ngày buổi học hoặc buổi đã hủy: chỉ xem',
    }),
    editableUntil: z.iso.datetime({ offset: true }).meta({
      description:
        'Hết cửa sổ sửa (cuối ngày thứ 7 theo múi giờ tenant); app hiện hạn cho người dùng',
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
      sessionDate: '2026-12-15',
      startsAt: '2026-12-15T18:00:00+07:00',
      sessionStatus: 'taught',
      canEdit: true,
      editableUntil: '2026-12-22T23:59:59+07:00',
      serverTime: '2026-12-15T19:40:00+07:00',
      items: [
        {
          studentId: '019b2c42-0001-7a10-8a01-000000000001',
          fullName: 'Nguyễn Minh An',
          status: 'present',
          note: null,
          clientUpdatedAt: '2026-12-15T19:35:00+07:00',
          syncedAt: '2026-12-15T19:35:02+07:00',
        },
        {
          studentId: '019b2c42-0001-7a10-8a01-000000000002',
          fullName: 'Trần Bảo Châu',
          status: 'unexcused',
          note: null,
          clientUpdatedAt: '2026-12-15T19:35:00+07:00',
          syncedAt: '2026-12-15T19:35:02+07:00',
        },
      ],
      summary: { present: 1, late: 0, excused: 0, unexcused: 1 },
    },
  });
export type SessionAttendance = z.infer<typeof sessionAttendanceSchema>;

// ---- POST /attendance/sync ----

export const attendanceMutationSchema = z.object({
  clientMutationId: z.uuid().meta({
    description:
      'UUID do app sinh. Khóa dedupe là (tenant, `clientMutationId`), phạm vi TENANT. `duplicate` chỉ khi bản đã nhận cùng tenant và cùng `sessionId`; trùng với tenant khác hay buổi khác không bao giờ lộ ra.',
  }),
  studentId: z.uuid(),
  status: attendanceStatusSchema,
  note: noteSchema,
  clientUpdatedAt: lwwTime.meta({
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
    markSessionTaught: z
      .boolean()
      .default(false)
      .meta({
        description:
          'true = chuyển buổi sang "đã dạy". Buổi đã "đã dạy" thì idempotent: bỏ qua cờ, không lỗi `SESSION_ALREADY_TAUGHT`. ' +
          'Học viên không có trong `mutations` được hiểu là "Có mặt": server chỉ tạo dòng cho học viên CHƯA có dòng, không ghi đè dòng sẵn có; `summary` đếm cả dòng tạo ngầm.',
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
    studentId: z.uuid(),
    result: z.enum(['applied', 'duplicate', 'stale', 'rejected']).meta({
      description:
        'applied = đã ghi; duplicate = đã nhận trước đó; stale = bản trên server mới hơn hoặc bằng (LWW dùng `>`), client cập nhật theo `current`; rejected = không ghi, xem `errorCode`',
    }),
    errorCode: z.enum(MUTATION_ERROR_CODES).optional().meta({
      description:
        'Chỉ có khi `rejected`. NOT_FOUND: học viên của tenant khác và học viên không thuộc lớp của buổi cho cùng kết quả, không phân biệt được.',
    }),
    current: attendanceCurrentSchema.optional().meta({
      description: 'Bản đang lưu trên server; có khi `stale` và `duplicate`',
    }),
  })
  .meta({ id: 'AttendanceMutationResult' });

export const attendanceSyncResultSchema = z
  .object({
    sessionId: z.uuid(),
    sessionStatus: sessionStatusSchema,
    serverTime: lwwTime,
    results: z
      .array(attendanceMutationResultSchema)
      .meta({ description: 'Đúng thứ tự và số phần tử của `mutations`' }),
    summary: summarySchema.meta({
      description: 'Cả buổi sau lô này, kể cả dòng "Có mặt" tạo ngầm',
    }),
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
      serverTime: '2026-12-15T19:02:12+07:00',
      results: [
        {
          clientMutationId: '019b2c51-0001-7a10-8a01-000000000001',
          studentId: '019b2c42-0001-7a10-8a01-000000000002',
          result: 'applied',
        },
        {
          clientMutationId: '019b2c51-0001-7a10-8a01-000000000002',
          studentId: '019b2c42-0001-7a10-8a01-000000000003',
          result: 'stale',
          current: {
            status: 'present',
            note: null,
            clientUpdatedAt: '2026-12-15T19:03:00+07:00',
            recordedByName: 'Cô Lan',
          },
        },
      ],
      summary: { present: 16, late: 0, excused: 1, unexcused: 1 },
      parentsToNotify: 1,
    },
  });
export type AttendanceSyncResult = z.infer<typeof attendanceSyncResultSchema>;

// ---- GET /sessions/{id}/attendance/history ----

export const attendanceHistoryQuerySchema = cursorQuerySchema(100);
export type AttendanceHistoryQuery = z.infer<
  typeof attendanceHistoryQuerySchema
>;

const stateSchema = z.object({
  status: attendanceStatusSchema,
  note: z.string().nullable(),
});

export const attendanceHistoryItemSchema = z
  .object({
    id: z.uuid(),
    studentId: z.uuid(),
    studentName: z.string(),
    changedByName: z.string().nullable().meta({
      description: 'Chỉ tên hiển thị; không trả userId hay email của người sửa',
    }),
    changedAt: z.iso.datetime({ offset: true }),
    before: stateSchema
      .nullable()
      .meta({ description: '`null` = lần điểm danh đầu' }),
    after: stateSchema,
  })
  .meta({ id: 'AttendanceHistoryItem' });

export const attendanceHistorySchema = cursorPageSchema(
  attendanceHistoryItemSchema,
).meta({
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
    nextCursor: null,
  },
});
export type AttendanceHistory = z.infer<typeof attendanceHistorySchema>;
