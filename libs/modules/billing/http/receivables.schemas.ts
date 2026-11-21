import { z } from 'zod';
import {
  pageQuerySchema,
  paginatedSchema,
  signedVndSchema,
  vndSchema,
} from '@teachhub/core';
import { invoiceStatusSchema } from './billing.schemas.js';
import { paymentSchema } from './payments.schemas.js';
import { dunningStepStatusSchema } from './dunning.schemas.js';

// Hợp đồng Sprint 6 "Thu tiền" (S5-FL-09): công nợ và tuổi nợ (T11, US-8.3, P1). Thân hàm ở S6-BE-05.

export const agingBucketSchema = z.enum(['0-30', '31-60', 'over-60']).meta({
  id: 'AgingBucket',
  description:
    'Tuổi nợ = số ngày từ hạn thanh toán của hóa đơn cũ nhất còn nợ tới hôm nay (múi giờ tenant): `0-30` (gồm hóa đơn chưa tới hạn), `31-60`, `over-60` (> 60 ngày)',
});

export const receivableSortFieldSchema = z
  .enum(['amount', 'overdueDays', 'studentName'])
  .meta({ id: 'ReceivableSortField' });

export const receivablesQuerySchema = pageQuerySchema.extend({
  agingBucket: agingBucketSchema.optional().meta({
    description:
      'Chỉ học viên thuộc nhóm tuổi nợ này. Phần `summary` không bị lọc theo tham số này để thanh nhóm vẫn đủ ba số',
  }),
  classId: z.uuid().optional().meta({
    description: 'Chỉ học viên đang học lớp này (có hóa đơn nợ gồm lớp đó)',
  }),
  sortField: receivableSortFieldSchema.default('amount'),
  sortOrder: z.enum(['asc', 'desc']).default('desc').meta({
    description: 'Mặc định `amount` giảm dần (US-8.3 AC2)',
  }),
});
export type ReceivablesQuery = z.infer<typeof receivablesQuerySchema>;

export const receivableRowSchema = z
  .object({
    studentId: z.uuid(),
    studentName: z.string(),
    classNames: z.array(z.string()).meta({
      description: 'Lớp học viên đang học (hiện ở mỗi dòng, US-8.3 AC1)',
    }),
    outstandingAmount: vndSchema('Tổng số còn nợ, > 0'),
    openInvoiceCount: z.int().min(1),
    oldestDueDate: z.iso.date().meta({
      description: 'Hạn thanh toán của hóa đơn cũ nhất còn nợ',
    }),
    overdueDays: z.int().min(0).meta({
      description:
        'Số ngày quá hạn tính từ `oldestDueDate`; 0 khi chưa tới hạn',
    }),
    agingBucket: agingBucketSchema,
  })
  .meta({ id: 'ReceivableRow' });

export const agingSummarySchema = z
  .object({
    agingBucket: agingBucketSchema,
    studentCount: z.int().min(0),
    totalAmount: vndSchema('Tổng nợ của nhóm'),
  })
  .meta({ id: 'AgingSummary' });

export const receivablesSchema = paginatedSchema(receivableRowSchema)
  .extend({
    summary: z.object({
      totalAmount: vndSchema('Tổng nợ mọi nhóm'),
      buckets: z.array(agingSummarySchema).meta({
        description: 'Luôn đủ ba nhóm theo thứ tự `0-30`, `31-60`, `over-60`',
      }),
    }),
  })
  .meta({
    id: 'Receivables',
    description:
      'Công nợ của tenant (T11): mỗi dòng một học viên còn nợ, sắp theo số nợ giảm dần mặc định, kèm tổng theo nhóm tuổi nợ (US-8.3 AC1, AC2). Nợ = Σ `remainingAmount` các hóa đơn `issued`/`partially_paid` của học viên; khoản đã nằm trong dòng `carry_over` của hóa đơn kỳ sau chỉ tính ở hóa đơn kỳ sau, không tính hai lần. Học viên không còn nợ không có dòng',
    example: {
      items: [
        {
          studentId: '019b2c4f-0001-7b30-8c01-000000000001',
          studentName: 'Nguyễn Minh Anh',
          classNames: ['Toán 9A'],
          outstandingAmount: 700000,
          openInvoiceCount: 1,
          oldestDueDate: '2027-01-10',
          overdueDays: 12,
          agingBucket: '0-30',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      summary: {
        totalAmount: 700000,
        buckets: [
          { agingBucket: '0-30', studentCount: 1, totalAmount: 700000 },
          { agingBucket: '31-60', studentCount: 0, totalAmount: 0 },
          { agingBucket: 'over-60', studentCount: 0, totalAmount: 0 },
        ],
      },
    },
  });
export type Receivables = z.infer<typeof receivablesSchema>;

// ---- Lịch sử của một học viên (US-8.3 AC3) ----

export const receivableInvoiceSchema = z
  .object({
    id: z.uuid(),
    code: z.string().nullable(),
    periodMonth: z.iso.date(),
    status: invoiceStatusSchema,
    totalAmount: vndSchema('VND'),
    paidAmount: vndSchema('Σ thanh toán chưa hủy'),
    remainingAmount: vndSchema('max(0, `totalAmount` − `paidAmount`)'),
    dueDate: z.iso.date(),
  })
  .meta({ id: 'ReceivableInvoice' });

export const receivablePaymentSchema = paymentSchema
  .extend({
    invoiceCode: z.string().nullable(),
  })
  .meta({ id: 'ReceivablePayment' });

export const receivableReminderSchema = z
  .object({
    invoiceId: z.uuid(),
    invoiceCode: z.string().nullable(),
    offsetDays: z.int(),
    scheduledFor: z.iso.datetime({ offset: true }),
    status: dunningStepStatusSchema,
    sentAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'ReceivableReminder' });

export const receivableEnrollmentSchema = z
  .object({
    enrollmentId: z.uuid(),
    classId: z.uuid(),
    className: z.string(),
    dunningEnabled: z.boolean(),
  })
  .meta({ id: 'ReceivableEnrollment' });

export const studentReceivableHistorySchema = z
  .object({
    studentId: z.uuid(),
    studentName: z.string(),
    outstandingAmount: vndSchema('Tổng nợ hiện tại; 0 khi hết nợ'),
    ledgerBalanceAmount: signedVndSchema(
      'Số dư sổ học viên (`GET /students/{id}/ledger`): dương = nợ cũ chưa vào hóa đơn, âm = trả thừa',
    ),
    dunningEnabled: z.boolean().meta({
      description:
        'Học viên có được nhắc nợ không (khớp `studentDunningEnabled` của `PUT /enrollments/{id}/dunning`)',
    }),
    enrollments: z.array(receivableEnrollmentSchema).meta({
      description:
        'Ghi danh đang mở, để app gọi `PUT /enrollments/{id}/dunning` cho từng ghi danh khi bật/tắt nhắc theo học viên',
    }),
    invoices: z.array(receivableInvoiceSchema),
    payments: z.array(receivablePaymentSchema),
    reminders: z.array(receivableReminderSchema),
  })
  .meta({
    id: 'StudentReceivableHistory',
    description:
      'Lịch sử hóa đơn, thanh toán và nhắc nợ của một học viên (US-8.3 AC3), mở từ một dòng của T11. Mới nhất trước, chưa phân trang: `invoices` tối đa 24, `payments` và `reminders` tối đa 50 bản ghi mới nhất. Chỉ hóa đơn đã phát hành (không có bản nháp)',
  });
export type StudentReceivableHistory = z.infer<
  typeof studentReceivableHistorySchema
>;
