import { z } from 'zod';

// Hợp đồng Sprint 6 "Thu tiền" (S5-FL-09): nhắc nợ tự động (US-7.5). Thân hàm ở S6-BE-04.
// Mốc nhắc tính theo ngày so với hạn thanh toán của hóa đơn: -1 = trước hạn 1 ngày, 0 = đúng hạn, 3 = quá hạn 3 ngày.

const offsetDay = z.int().min(-7).max(30);

export const dunningOffsetsSchema = z
  .array(offsetDay)
  .min(1)
  .max(6)
  .refine(
    (a) => a.every((v, i) => i === 0 || v > a[i - 1]!),
    'Các mốc phải tăng dần, không trùng.',
  )
  .meta({
    description:
      'Mốc nhắc (ngày so với hạn thanh toán, -7 đến 30), 1 đến 6 mốc, tăng dần và không trùng. Mặc định `[-1, 0, 3, 7]` (US-7.5 AC1)',
    example: [-1, 0, 3, 7],
  });

export const dunningSettingsSchema = z
  .object({
    enabled: z.boolean().meta({
      description:
        'Công tắc chung của tenant: tắt thì không tạo lời nhắc cho hóa đơn phát hành sau đó và hủy lời nhắc chưa gửi của hóa đơn đang mở',
    }),
    offsetsDays: dunningOffsetsSchema,
  })
  .meta({
    id: 'DunningSettings',
    description:
      'Lịch nhắc nợ của tenant. Job `billing.dunning` chạy mỗi 15 phút từ 07:00 đến 21:30 giờ tenant và chỉ gửi trong khung đó (ngoài giờ yên lặng, US-7.5 AC1). Đổi lịch chỉ áp cho hóa đơn phát hành sau khi lưu; lời nhắc đã lập của hóa đơn cũ giữ nguyên',
    example: { enabled: true, offsetsDays: [-1, 0, 3, 7] },
  });
export type DunningSettings = z.infer<typeof dunningSettingsSchema>;

export const updateDunningSettingsRequestSchema = dunningSettingsSchema.meta({
  id: 'UpdateDunningSettingsRequest',
  description:
    'Thay toàn bộ cài đặt: cả `enabled` và `offsetsDays` đều bắt buộc',
});
export type UpdateDunningSettingsRequest = z.infer<
  typeof updateDunningSettingsRequestSchema
>;

export const dunningPreviewQuerySchema = z.object({
  offsetDays: z.coerce.number().int().min(-7).max(30).meta({
    description: 'Mốc cần xem trước (ngày so với hạn thanh toán)',
    example: 3,
  }),
});
export type DunningPreviewQuery = z.infer<typeof dunningPreviewQuerySchema>;

export const dunningPreviewSchema = z
  .object({
    offsetDays: z.int(),
    title: z.string(),
    body: z.string(),
  })
  .meta({
    id: 'DunningPreview',
    description:
      'Mẫu tin nhắc nợ dựng bằng dữ liệu mẫu (không có tên hay số tiền thật). Tin gửi thật do hệ thống đứng tên ("TeachHub nhắc…") kèm số còn nợ, hạn và nút mở hóa đơn (US-7.5 AC4)',
    example: {
      offsetDays: 3,
      title: 'TeachHub nhắc học phí',
      body: 'TeachHub nhắc: hóa đơn TH-25K7Q9 của bé đã quá hạn 3 ngày, còn 700.000 đ. Mở hóa đơn để chuyển khoản.',
    },
  });
export type DunningPreview = z.infer<typeof dunningPreviewSchema>;

// ---- Theo học viên (ghi danh) ----

export const putEnrollmentDunningRequestSchema = z
  .object({
    enabled: z.boolean().meta({
      description:
        '`false` = tắt nhắc nợ; mọi lời nhắc chưa gửi của hóa đơn của học viên đó bị hủy (US-7.5 AC3). `true` = bật lại, lập lại các mốc chưa tới của hóa đơn còn nợ',
    }),
  })
  .meta({
    id: 'PutEnrollmentDunningRequest',
    example: { enabled: false },
  });
export type PutEnrollmentDunningRequest = z.infer<
  typeof putEnrollmentDunningRequestSchema
>;

export const enrollmentDunningResultSchema = z
  .object({
    enrollmentId: z.uuid(),
    studentId: z.uuid(),
    enabled: z.boolean().meta({ description: 'Giá trị của ghi danh này' }),
    studentDunningEnabled: z.boolean().meta({
      description:
        'Học viên có được nhắc không: `true` khi còn ít nhất một ghi danh đang mở bật nhắc. Hóa đơn gộp mọi lớp nên chỉ khi mọi ghi danh đang mở đều tắt thì học viên mới không được nhắc',
    }),
    cancelledCount: z.int().min(0).meta({
      description: 'Số lời nhắc chưa gửi vừa bị hủy (0 khi bật lại)',
    }),
  })
  .meta({ id: 'EnrollmentDunningResult' });
export type EnrollmentDunningResult = z.infer<
  typeof enrollmentDunningResultSchema
>;

// ---- Theo hóa đơn ----

export const dunningStepStatusSchema = z
  .enum(['pending', 'sent', 'cancelled'])
  .meta({
    id: 'DunningStepStatus',
    description:
      '`pending` = chờ tới mốc, `sent` = đã gửi, `cancelled` = hủy do thu đủ, tắt nhắc, hóa đơn hủy hoặc tenant tắt nhắc',
  });

export const dunningStepSchema = z
  .object({
    offsetDays: z.int(),
    scheduledFor: z.iso.datetime({ offset: true }),
    status: dunningStepStatusSchema,
    sentAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'DunningStep' });

export const invoiceDunningSchema = z
  .object({
    invoiceId: z.uuid(),
    enabled: z.boolean().meta({
      description:
        'Còn lời nhắc nào sẽ gửi không; `false` thì `disabledReason` khác null',
    }),
    disabledReason: z
      .enum(['tenant_disabled', 'student_disabled', 'paid', 'void'])
      .nullable()
      .meta({
        description:
          '`tenant_disabled` = tenant tắt nhắc, `student_disabled` = học viên tắt nhắc, `paid` = hóa đơn đã thu đủ hoặc đang chờ giáo viên xác nhận lần báo chuyển khoản (`pending_confirmation`, mốc nhắc tạm dừng và lập lại khi bị từ chối), `void` = hóa đơn hủy',
      }),
    steps: z.array(dunningStepSchema).meta({
      description:
        'Các mốc đã lập theo thứ tự thời gian; rỗng với bản nháp và hóa đơn 0 đ (không nhắc, US-1.3 AC3)',
    }),
  })
  .meta({
    id: 'InvoiceDunning',
    description:
      'Trạng thái nhắc nợ của một hóa đơn (đọc để hiện lịch sử nhắc ở T10 và T11). Không có endpoint tắt riêng một hóa đơn: US-7.5 AC3 tắt theo học viên',
    example: {
      invoiceId: '019c0a10-0001-7b30-8c01-000000000001',
      enabled: true,
      disabledReason: null,
      steps: [
        {
          offsetDays: -1,
          scheduledFor: '2027-01-09T09:00:00+07:00',
          status: 'sent',
          sentAt: '2027-01-09T09:00:12+07:00',
        },
        {
          offsetDays: 0,
          scheduledFor: '2027-01-10T09:00:00+07:00',
          status: 'pending',
          sentAt: null,
        },
      ],
    },
  });
export type InvoiceDunning = z.infer<typeof invoiceDunningSchema>;
