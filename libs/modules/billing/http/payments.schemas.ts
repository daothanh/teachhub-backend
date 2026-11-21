import { z } from 'zod';
import {
  MAX_VND,
  pageQuerySchema,
  paginatedSchema,
  signedVndSchema,
  vndSchema,
} from '@teachhub/core';
import { invoiceStatusSchema, paymentMethodSchema } from './billing.schemas.js';

// Hợp đồng Sprint 6 "Thu tiền" (S5-FL-09, S5-CT-01): thanh toán, sổ học viên. Tiền: số nguyên đồng (`libs/core/src/money.ts`).
// Thân hàm ở S6-BE-02 (thanh toán), S6-BE-03 (sổ học viên, số dư chuyển kỳ).

// ---- Thanh toán (US-7.4) ----

const actorSchema = z
  .object({
    id: z.uuid(),
    name: z.string().meta({ description: 'Tên hiển thị' }),
  })
  .nullable()
  .meta({
    id: 'PaymentActor',
    description:
      '`recordedBy` = người ghi, `voidedBy` = người hủy (null khi chưa hủy): id và tên hiển thị. Tên là ảnh chụp lúc ghi/hủy, giữ nguyên khi người đó đổi tên hoặc xóa tài khoản (không còn null vì tài khoản đã xóa)',
  });

export const paymentSchema = z
  .object({
    id: z.uuid(),
    invoiceId: z.uuid(),
    amount: vndSchema('VND, > 0'),
    method: paymentMethodSchema,
    paidOn: z.iso.date().meta({
      description: 'Ngày thu theo múi giờ tenant (mặc định hôm nay)',
    }),
    note: z.string().nullable().meta({ description: 'Ghi chú của giáo viên' }),
    recordedAt: z.iso.datetime({ offset: true }),
    recordedBy: actorSchema,
    voidedAt: z.iso.datetime({ offset: true }).nullable(),
    voidedBy: actorSchema,
    voidReason: z.string().nullable().meta({
      description: 'Có khi `voidedAt` khác null; chỉ giáo viên thấy',
    }),
  })
  .meta({
    id: 'Payment',
    description:
      'Một lần thu tiền của hóa đơn (chỉ phản hồi cho chủ tenant; phụ huynh chỉ có `FamilyPayment`, không có `recordedBy`, `voidedBy`, `note`, `voidReason`). Hủy không xóa dòng: `voidedAt` khác null và có bút toán đảo ở sổ doanh thu (US-7.4 AC4, US-9.5 AC1)',
    example: {
      id: '019c0b20-0001-7b30-8c01-000000000001',
      invoiceId: '019c0a10-0001-7b30-8c01-000000000001',
      amount: 500000,
      method: 'bank_transfer',
      paidOn: '2027-01-05',
      note: null,
      recordedAt: '2027-01-05T09:12:00+07:00',
      recordedBy: {
        id: '019b2c00-0001-7b30-8c01-000000000001',
        name: 'Cô Lan',
      },
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    },
  });
export type Payment = z.infer<typeof paymentSchema>;

export const recordPaymentRequestSchema = z
  .object({
    amount: z.int().min(1).max(MAX_VND).meta({
      description:
        'VND, số nguyên > 0 (mọi `amount` ≤ 0 → 422 `VALIDATION_FAILED`). Bằng số còn nợ là "Đã thu đủ", nhỏ hơn là "Thu một phần" (US-7.4 AC1, AC2). Lớn hơn số còn nợ vẫn nhận: hóa đơn `paid`, phần thừa vào sổ học viên để trừ kỳ sau (US-7.6 AC2)',
      example: 500000,
    }),
    method: paymentMethodSchema,
    paidOn: z.iso.date().optional().meta({
      description:
        'Ngày thu; bỏ trống = hôm nay theo múi giờ tenant. Phải từ ngày phát hành hóa đơn (theo múi giờ tenant) đến hôm nay, ngoài khoảng đó → 422 `VALIDATION_FAILED` ở `paidOn`',
      example: '2027-01-05',
    }),
    note: z.string().trim().max(300).optional(),
  })
  .meta({
    id: 'RecordPaymentRequest',
    example: { amount: 500000, method: 'bank_transfer', paidOn: '2027-01-05' },
  });
export type RecordPaymentRequest = z.infer<typeof recordPaymentRequestSchema>;

export const paymentResultSchema = z
  .object({
    payment: paymentSchema,
    status: invoiceStatusSchema.meta({
      description:
        'Trạng thái hóa đơn sau thao tác: `partially_paid`, `paid` hoặc (sau hủy thanh toán cuối) `issued`',
    }),
    paidAmount: vndSchema('Σ thanh toán chưa hủy của hóa đơn sau thao tác'),
    remainingAmount: vndSchema(
      'max(0, `totalAmount` − `paidAmount` − phần nợ đã chuyển sang hóa đơn kỳ sau)',
    ),
    overpaidAmount: vndSchema(
      'max(0, `paidAmount` − `totalAmount`): phần trả thừa đã ghi vào sổ học viên (US-7.6 AC2); 0 khi không thừa',
    ),
    dunningCancelled: z.boolean().meta({
      description:
        '`true` khi thao tác ghi thu đủ và các lời nhắc chưa gửi của hóa đơn vừa bị hủy (US-7.5 AC2). Luôn `false` khi hủy thanh toán',
    }),
  })
  .meta({
    id: 'PaymentResult',
    example: {
      payment: {
        id: '019c0b20-0001-7b30-8c01-000000000001',
        invoiceId: '019c0a10-0001-7b30-8c01-000000000001',
        amount: 500000,
        method: 'bank_transfer',
        paidOn: '2027-01-05',
        note: null,
        recordedAt: '2027-01-05T09:12:00+07:00',
        recordedBy: {
          id: '019b2c00-0001-7b30-8c01-000000000001',
          name: 'Cô Lan',
        },
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
      },
      status: 'partially_paid',
      paidAmount: 500000,
      remainingAmount: 700000,
      overpaidAmount: 0,
      dunningCancelled: false,
    },
  });
export type PaymentResult = z.infer<typeof paymentResultSchema>;

export const voidPaymentRequestSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, 'Vui lòng nhập lý do hủy thanh toán.')
      .max(300)
      .meta({
        description:
          'Bắt buộc (US-7.4 AC4); ghi nhật ký kiểm toán cùng người hủy',
      }),
  })
  .meta({
    id: 'VoidPaymentRequest',
    example: { reason: 'Ghi nhầm hóa đơn' },
  });
export type VoidPaymentRequest = z.infer<typeof voidPaymentRequestSchema>;

export const paymentListSchema = z
  .object({ items: z.array(paymentSchema) })
  .meta({
    id: 'PaymentList',
    description:
      'Mọi thanh toán của hóa đơn, mới ghi trước, gồm cả đã hủy (`voidedAt` khác null). Không phân trang: một hóa đơn có ít lần thu',
  });
export type PaymentList = z.infer<typeof paymentListSchema>;

// ---- Sổ học viên (US-7.6) ----

export const ledgerEntryKindSchema = z
  .enum([
    'unpaid_carried',
    'overpayment',
    'prev_adjustment',
    'applied_to_invoice',
    'payment_void',
  ])
  .meta({
    id: 'LedgerEntryKind',
    description:
      '`unpaid_carried` = phần chưa thu của hóa đơn kỳ trước chuyển kỳ sau (ghi nợ), `overpayment` = trả thừa (ghi có), `prev_adjustment` = chênh lệch do sửa điểm danh sau phát hành (nợ hoặc có), `applied_to_invoice` = khoản đã đưa vào dòng `carry_over` của hóa đơn kỳ sau (bút toán đối ứng), `payment_void` = đảo do hủy thanh toán. Client coi giá trị lạ như dòng thường',
  });

export const ledgerEntrySchema = z
  .object({
    id: z.uuid(),
    kind: ledgerEntryKindSchema,
    debitAmount: vndSchema('Học viên nợ thêm; 0 nếu dòng này là ghi có'),
    creditAmount: vndSchema('Học viên được trừ; 0 nếu dòng này là ghi nợ'),
    description: z.string(),
    invoiceId: z.uuid().nullable(),
    paymentId: z.uuid().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: 'LedgerEntry',
    description:
      'Một dòng sổ cái công nợ (`student_ledger`), chỉ ghi thêm, không sửa hay xóa. Mỗi dòng chỉ một trong `debitAmount`, `creditAmount` khác 0',
  });

export const studentLedgerQuerySchema = pageQuerySchema;
export type StudentLedgerQuery = z.infer<typeof studentLedgerQuerySchema>;

export const studentLedgerSchema = z
  .object({
    studentId: z.uuid(),
    studentName: z.string(),
    balanceAmount: signedVndSchema(
      'Σ(`debitAmount` − `creditAmount`): dương = còn nợ cũ chưa vào hóa đơn nào, âm = tiền trả thừa chờ trừ kỳ sau, 0 = sạch',
    ),
    debtAmount: vndSchema('max(0, `balanceAmount`): nợ cũ'),
    creditAmount: vndSchema('max(0, −`balanceAmount`): tiền trả thừa'),
    entries: paginatedSchema(ledgerEntrySchema).meta({
      description: 'Mới nhất trước, phân trang offset',
    }),
  })
  .meta({
    id: 'StudentLedger',
    description:
      'Số dư chuyển kỳ của một học viên (US-7.6). Bản nháp kỳ sau lấy số dư này làm dòng `carry_over`: nợ → dòng dương "Nợ kỳ trước", trả thừa → dòng âm; tổng hóa đơn âm thì hóa đơn = 0 đ và phần dư tiếp tục ở sổ (US-7.6 AC4)',
    example: {
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      studentName: 'Nguyễn Minh Anh',
      balanceAmount: 200000,
      debtAmount: 200000,
      creditAmount: 0,
      entries: {
        items: [
          {
            id: '019c0b30-0001-7b30-8c01-000000000001',
            kind: 'unpaid_carried',
            debitAmount: 200000,
            creditAmount: 0,
            description: 'Nợ kỳ trước (tháng 12/2026)',
            invoiceId: '019c0a10-0001-7b30-8c01-000000000001',
            paymentId: null,
            createdAt: '2027-02-01T02:00:00+07:00',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
  });
export type StudentLedger = z.infer<typeof studentLedgerSchema>;
