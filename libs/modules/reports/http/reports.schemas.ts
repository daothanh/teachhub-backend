import { z } from 'zod';
import {
  pageQuerySchema,
  paginatedSchema,
  signedVndSchema,
  vndSchema,
} from '@teachhub/core';
import { paymentMethodSchema } from '../../billing/http/billing.schemas.js';

// Hợp đồng Sprint 7 (S6-FL-06, S6-CT-01): báo cáo doanh thu cho giáo viên (T12, US-8.1, US-8.2).
// Thân hàm ở task backend `reports` (Spec §5.4 M8). Tiền: số nguyên đồng (`libs/core/src/money.ts`).

export const reportMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Tháng phải có dạng YYYY-MM.');

export const reportMonthQuerySchema = z.object({
  month: reportMonthSchema.optional().meta({
    description:
      'Tháng dương lịch `YYYY-MM` theo múi giờ tenant; bỏ trống = tháng hiện tại. Tháng tương lai hợp lệ, số liệu bằng 0',
    example: '2026-11',
  }),
});
export type ReportMonthQuery = z.infer<typeof reportMonthQuerySchema>;

const collectedAmount = (description: string) =>
  signedVndSchema(
    `${description} Có dấu: bằng Σ \`amount\` của \`revenue_ledger\` có \`entry_date\` trong tháng, gồm cả dòng đảo do hủy thanh toán (hủy thanh toán của tháng trước làm tháng này giảm), nên hiếm khi âm`,
  );

// ---- Tổng quan tháng (T12, US-8.1) ----

export const monthOverviewSchema = z
  .object({
    month: reportMonthSchema,
    billedAmount: vndSchema(
      '"Phải thu": Σ `totalAmount` hóa đơn đã phát hành (không `draft`, không `void`) của kỳ thu tháng này (US-8.1 AC1)',
    ),
    collectedAmount: collectedAmount(
      '"Đã thu": tổng thanh toán ghi trong tháng (US-8.1 AC1).',
    ),
    outstandingAmount: vndSchema(
      '"Công nợ": nợ ròng HIỆN TẠI của mọi học viên, không phụ thuộc tháng chọn; bằng `summary.totalAmount` của `GET /receivables` (US-8.1 AC1)',
    ),
    activeStudentCount: z.int().min(0).meta({
      description: '"HS đang học": học viên `active` hiện tại',
    }),
    hasData: z.boolean().meta({
      description:
        '`false` khi tháng không có hóa đơn phát hành lẫn thanh toán (màn hiện "Chưa có dữ liệu tháng này")',
    }),
  })
  .meta({
    id: 'MonthOverview',
    description:
      'Bốn ô số của T12. Chạm vào số (US-8.1 AC3) mở danh sách tạo nên số đó: Phải thu → `GET /billing-periods?month=` rồi `GET /billing-periods/{id}`; Đã thu → `GET /reports/payments?month=`; Công nợ → `GET /receivables`; HS đang học → `GET /students`',
    example: {
      month: '2026-11',
      billedAmount: 72400000,
      collectedAmount: 65600000,
      outstandingAmount: 6800000,
      activeStudentCount: 46,
      hasData: true,
    },
  });
export type MonthOverview = z.infer<typeof monthOverviewSchema>;

// ---- Danh sách khoản thu của tháng (US-8.1 AC2, AC3) ----

export const revenueEntryKindSchema = z.enum(['payment', 'reversal']).meta({
  id: 'RevenueEntryKind',
  description:
    '`payment` = dòng ghi khi thu tiền; `reversal` = dòng đảo khi hủy thanh toán (`amount` âm, US-9.5 AC1). Client coi giá trị lạ như `payment`',
});

export const revenueEntrySchema = z
  .object({
    id: z.uuid().meta({ description: 'Id dòng `revenue_ledger`' }),
    kind: revenueEntryKindSchema,
    paymentId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceCode: z.string().nullable().meta({ example: 'TH-25K7Q9' }),
    studentId: z.uuid(),
    studentName: z.string(),
    method: paymentMethodSchema,
    entryDate: z.iso.date().meta({
      description:
        'Ngày ghi sổ theo múi giờ tenant: `paidOn` của thanh toán với `payment`; ngày hủy với `reversal`',
    }),
    amount: signedVndSchema('Có dấu: dương với `payment`, âm với `reversal`'),
  })
  .meta({ id: 'RevenueEntry' });

export const revenueEntriesQuerySchema = pageQuerySchema.extend({
  month: reportMonthQuerySchema.shape.month,
});
export type RevenueEntriesQuery = z.infer<typeof revenueEntriesQuerySchema>;

export const revenueEntriesSchema = paginatedSchema(revenueEntrySchema)
  .extend({
    totalAmount: collectedAmount(
      'Σ `amount` của MỌI dòng trong tháng (không chỉ trang này); bằng `collectedAmount` của `GET /reports/month-overview` (US-8.1 AC2, sai lệch 0 đồng).',
    ),
  })
  .meta({ id: 'RevenueEntryPage' });
export type RevenueEntries = z.infer<typeof revenueEntriesSchema>;

// ---- Doanh thu theo lớp và 12 tháng (T12, US-8.2) ----

export const classRevenueSchema = z
  .object({
    classId: z.uuid().nullable().meta({
      description:
        'null = dòng "Khác": phần tiền không gán được cho lớp nào (vd. thanh toán trả nợ cũ `carry_over`, phụ thu không thuộc lớp)',
    }),
    className: z
      .string()
      .nullable()
      .meta({ description: 'null khi `classId` null' }),
    archived: z.boolean().meta({
      description:
        'Lớp đã lưu trữ vẫn có dòng với số liệu lịch sử (US-8.2 AC2)',
    }),
    collectedAmount: collectedAmount('Phần "đã thu" của tháng gán cho lớp.'),
    attendancePercent: z.number().min(0).max(100).nullable().meta({
      description:
        'Chuyên cần của lớp trong tháng, % làm tròn một chữ số thập phân: (có mặt + đi muộn) / tổng lượt của buổi đã dạy (US-8.4 AC1). null khi lớp không có buổi đã dạy trong tháng',
      example: 92,
    }),
  })
  .meta({ id: 'ClassRevenue' });

export const revenueByClassSchema = z
  .object({
    month: reportMonthSchema,
    collectedAmount: collectedAmount(
      'Tổng mọi dòng; bằng `collectedAmount` của `GET /reports/month-overview` (US-8.2 AC3).',
    ),
    items: z.array(classRevenueSchema).meta({
      description:
        'Sắp theo `collectedAmount` giảm dần, dòng "Khác" (nếu có) ở cuối. Không phân trang (số lớp của một giáo viên nhỏ)',
    }),
  })
  .meta({
    id: 'RevenueByClass',
    description:
      'Một khoản thanh toán thuộc hóa đơn gộp nhiều lớp được chia cho các lớp theo tỷ lệ dòng học phí dương của từng lớp trong hóa đơn đó (`session`, `monthly`, `course_installment`, `surcharge`), làm tròn đồng theo phần dư lớn nhất để tổng các lớp bằng đúng số tiền thanh toán; phần không gán được vào dòng "Khác" (`classId = null`). Dòng đảo chia ngược cùng tỷ lệ của thanh toán gốc. **Quy tắc phân bổ do Owner/TL chốt (US-8.2 AC3 đòi tổng khớp tuyệt đối).**',
    example: {
      month: '2026-11',
      collectedAmount: 65600000,
      items: [
        {
          classId: '019b2c10-0001-7a10-8a01-0000000000a1',
          className: 'Toán 9A',
          archived: false,
          collectedAmount: 28800000,
          attendancePercent: 92,
        },
        {
          classId: null,
          className: null,
          archived: false,
          collectedAmount: 800000,
          attendancePercent: null,
        },
      ],
    },
  });
export type RevenueByClass = z.infer<typeof revenueByClassSchema>;

export const revenue12mSchema = z
  .object({
    months: z
      .array(
        z.object({
          month: reportMonthSchema,
          collectedAmount: collectedAmount('Đã thu của tháng.'),
        }),
      )
      .min(12)
      .max(12)
      .meta({
        description:
          'Đúng 12 phần tử liên tiếp kết thúc ở `month` của query, cũ nhất trước (cột biểu đồ T12); tháng không có dữ liệu là 0',
      }),
  })
  .meta({
    id: 'Revenue12m',
    example: {
      months: [
        { month: '2025-12', collectedAmount: 58000000 },
        { month: '2026-01', collectedAmount: 61200000 },
      ],
    },
  });
export type Revenue12m = z.infer<typeof revenue12mSchema>;
