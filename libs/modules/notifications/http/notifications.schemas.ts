import { z } from 'zod';
import { cursorPageSchema, cursorQuerySchema } from '@teachhub/core';

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

/** Sprint 3: báo vắng (US-3.2). Sprint 4 thêm `schedule_changed` (US-2.2). Sprint 5 thêm `billing_ready` và `invoice_issued`. */
export const notificationTypeSchema = z.enum([
  'student_absent',
  'student_absent_correction',
  'schedule_changed',
  'billing_ready',
  'invoice_issued',
]);

const absencePayloadSchema = z
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
  });

/**
 * Payload loại `schedule_changed` (US-2.2). CHƯA đưa vào `notificationSchema`: thêm thành viên vào `oneOf` của
 * phản hồi bị `oasdiff` coi là breaking (`response-property-one-of-added`). Chờ TL/Owner chấp nhận ngoại lệ rồi thêm
 * `notificationBase.extend({ type: z.literal('schedule_changed'), payload: scheduleChangedPayloadSchema })` vào union.
 */
export const scheduleChangedPayloadSchema = z
  .object({
    classId: z.uuid(),
    className: z.string(),
    sessionId: z.uuid(),
    change: z.enum(['rescheduled', 'cancelled', 'makeup']),
    sessionStartsAt: z.iso.datetime({ offset: true }),
    previousStartsAt: z.iso.datetime({ offset: true }).nullable().meta({
      description: 'Giờ cũ khi `change = rescheduled`; còn lại null',
    }),
    reason: z.string().max(300).nullable(),
  })
  .meta({
    description:
      'Lớp, buổi, giờ mới/cũ và lý do (nếu giáo viên nhập); không có dữ liệu học viên',
  });

/**
 * Payload loại `billing_ready` (US-7.2 AC1, gửi giáo viên khi `billing.close` tạo bản nháp). CHƯA nằm trong `notificationSchema`
 * vì cùng lý do `oasdiff` như `schedule_changed`. Push chỉ data-only (`notificationId`, `type`).
 */
export const billingReadyPayloadSchema = z
  .object({
    periodId: z.uuid(),
    periodMonth: z.iso.date(),
    draftCount: z.int().min(0),
    draftTotalAmount: z.int().min(0).meta({ description: 'VND' }),
  })
  .meta({
    description:
      'Kỳ và số bản nháp; text push "Học phí tháng X đã sẵn sàng" do client dựng từ `periodMonth`. deepLink `teachhub://billing/periods/{periodId}`',
  });

/**
 * Payload loại `invoice_issued` (US-7.3, gửi phụ huynh qua outbox `invoice_issued`, kèm email). CHƯA nằm trong `notificationSchema`.
 * Không có số tài khoản hay mã QR: phụ huynh mở hóa đơn qua `GET /family/invoices/{invoiceId}`.
 */
export const invoiceIssuedPayloadSchema = z
  .object({
    invoiceId: z.uuid(),
    studentId: z.uuid(),
    studentName: z.string(),
    periodMonth: z.iso.date(),
    totalAmount: z.int().min(1).meta({ description: 'VND' }),
    dueDate: z.iso.date(),
  })
  .meta({
    description:
      'Hóa đơn mới phát hành của một con. deepLink `teachhub://invoices/{invoiceId}`',
  });

const notificationBase = z.object({
  id: z.uuid(),
  urgency: z.enum(['normal', 'urgent']),
  deepLink: z.string().max(500).optional().meta({
    description: 'Đường dẫn mở đúng màn; thiếu thì client tự suy từ `payload`',
  }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const notificationSchema = z
  .discriminatedUnion('type', [
    notificationBase.extend({
      type: z.literal('student_absent'),
      payload: absencePayloadSchema,
    }),
    notificationBase.extend({
      type: z.literal('student_absent_correction'),
      payload: absencePayloadSchema,
    }),
  ])
  .meta({
    id: 'Notification',
    description:
      '`payload` theo `type`. Client bỏ qua (không lỗi) phần tử có `type` lạ để tương thích khi server thêm loại mới.',
  });

export const notificationsQuerySchema = cursorQuerySchema(50);
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

export const notificationsResponseSchema = cursorPageSchema(notificationSchema)
  .extend({
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
