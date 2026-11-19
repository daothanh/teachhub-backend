import { z } from 'zod';

// ---- POST /push/register · /push/unregister (G10, hợp đồng gói tasco_notifications) ----

const deviceToken = z.string().min(16).max(512).meta({
  description: 'Token FCM của thiết bị',
  example: 'fcm-token-mau-0123456789abcdef',
});

export const pushRegisterRequestSchema = z
  .object({
    userId: z.uuid().meta({
      description:
        'Phải trùng user của token đăng nhập, khác → 403 `FORBIDDEN`',
    }),
    deviceToken,
    platform: z.enum(['android', 'ios']),
  })
  .meta({
    id: 'PushRegisterRequest',
    example: {
      userId: '019b2c00-0001-7a10-8a01-000000000001',
      deviceToken: 'fcm-token-mau-0123456789abcdef',
      platform: 'ios',
    },
  });
export type PushRegisterRequest = z.infer<typeof pushRegisterRequestSchema>;

export const pushUnregisterRequestSchema = z
  .object({ userId: z.uuid(), deviceToken })
  .meta({
    id: 'PushUnregisterRequest',
    example: {
      userId: '019b2c00-0001-7a10-8a01-000000000001',
      deviceToken: 'fcm-token-mau-0123456789abcdef',
    },
  });
export type PushUnregisterRequest = z.infer<typeof pushUnregisterRequestSchema>;

// ---- GET /notifications · POST /notifications/read ----

/** Sprint 3 chỉ có hai loại, cùng cho báo vắng (US-3.2); loại khác thêm ở sprint sau. */
export const notificationTypeSchema = z.enum([
  'student_absent',
  'student_absent_correction',
]);

export const notificationSchema = z
  .object({
    id: z.uuid(),
    type: notificationTypeSchema,
    urgency: z.enum(['normal', 'urgent']),
    payload: z
      .object({
        studentId: z.uuid(),
        studentName: z.string(),
        classId: z.uuid(),
        className: z.string(),
        sessionId: z.uuid(),
        sessionStartsAt: z.iso.datetime({ offset: true }),
      })
      .meta({
        description:
          'Chỉ tên con, lớp, giờ buổi và các id để mở đúng màn; không có trạng thái khác hay ghi chú',
      }),
    readAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'Notification' });

export const notificationsQuerySchema = z.object({
  cursor: z.string().max(200).optional().meta({
    description: '`nextCursor` của trang trước (mã hóa `(created_at, id)`)',
  }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

export const notificationsResponseSchema = z
  .object({
    items: z.array(notificationSchema),
    nextCursor: z.string().nullable(),
    unreadCount: z.int().min(0).meta({
      description: 'Số chưa đọc của vai trò đang mở, dùng cho huy hiệu',
    }),
  })
  .meta({
    id: 'NotificationList',
    example: {
      items: [
        {
          id: '019b2c70-0001-7a10-8a01-000000000001',
          type: 'student_absent',
          urgency: 'urgent',
          payload: {
            studentId: '019b2c42-0001-7a10-8a01-000000000002',
            studentName: 'Trần Bảo Châu',
            classId: '019b2c3f-5e01-7c20-9b01-000000000001',
            className: 'Toán 9A',
            sessionId: '019b2c41-0001-7a10-8a01-000000000001',
            sessionStartsAt: '2026-12-15T18:00:00+07:00',
          },
          readAt: null,
          createdAt: '2026-12-15T19:36:00+07:00',
        },
      ],
      nextCursor: null,
      unreadCount: 1,
    },
  });
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const markReadRequestSchema = z
  .object({ ids: z.array(z.uuid()).min(1).max(100) })
  .meta({
    id: 'MarkNotificationsReadRequest',
    example: { ids: ['019b2c70-0001-7a10-8a01-000000000001'] },
  });
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

export const markReadResultSchema = z
  .object({
    updated: z.int().min(0).meta({
      description:
        'Số thông báo vừa chuyển sang đã đọc; id của người khác hoặc đã đọc không tính',
    }),
    unreadCount: z.int().min(0),
  })
  .meta({
    id: 'MarkNotificationsReadResult',
    example: { updated: 1, unreadCount: 0 },
  });
export type MarkReadResult = z.infer<typeof markReadResultSchema>;
