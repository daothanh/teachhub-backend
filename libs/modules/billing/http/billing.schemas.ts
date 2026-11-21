import { z } from 'zod';
import {
  cursorPageSchema,
  cursorQuerySchema,
  pageQuerySchema,
  paginatedSchema,
  signedVndSchema,
  vndSchema,
} from '@teachhub/core';

// Hợp đồng Sprint 5 (S4-FL-10, S4-CT-01); Sprint 6 (S5-FL-09) bổ sung thanh toán ở `payments.schemas.ts`. Tiền: số nguyên đồng, xem `libs/core/src/money.ts`.
// Luật làm tròn (nghiệp vụ, US-7.1 AC6): mọi dòng có chia tỷ lệ (trọn khóa, trừ buổi hủy của kiểu theo tháng) làm tròn
// tới 1.000 đ, từ 500 đ trở lên làm tròn lên (888.889 → 889.000). Đơn giá nhập vào và dòng điều chỉnh tay giữ nguyên số nguyên đồng.

export const feeTypeSchema = z.enum(['per_session', 'monthly', 'course']).meta({
  id: 'FeeType',
  description:
    '`per_session` = đơn giá mỗi buổi, `monthly` = mức cố định mỗi tháng, `course` = tổng tiền cả khóa (chia theo `installments` đợt)',
});

/** Quy tắc tính tiền đầy đủ của một lớp (US-1.2). Kiểu theo buổi dùng hai công tắc vắng; theo tháng dùng `deductCancelled`; trọn khóa dùng `installments`. */
export const feeRulesSchema = z
  .object({
    chargeExcused: z.boolean().meta({
      description:
        'Tính tiền buổi vắng có phép (kiểu theo buổi). Mặc định bật (US-1.2 AC2)',
    }),
    chargeUnexcused: z.boolean().meta({
      description:
        'Tính tiền buổi vắng không phép (kiểu theo buổi). Mặc định bật',
    }),
    deductCancelled: z.boolean().meta({
      description:
        'Kiểu theo tháng: trừ phần tiền buổi giáo viên hủy mà không dạy bù = học phí / số buổi theo lịch × số buổi hủy, làm tròn 1.000 đ. Mặc định tắt',
    }),
    installments: z.int().min(1).max(36).meta({
      description:
        'Kiểu trọn khóa: số đợt thu (1 đến 36, khớp `InvoiceCalculator`). Mặc định 1; đợt cuối gánh phần chênh để tổng các đợt bằng đúng tổng khóa',
    }),
  })
  .meta({
    id: 'FeeRules',
    example: {
      chargeExcused: true,
      chargeUnexcused: true,
      deductCancelled: false,
      installments: 1,
    },
  });
export type FeeRulesDto = z.infer<typeof feeRulesSchema>;

/** Đầu vào `feeRules`: trường thiếu = giá trị mặc định (thay toàn bộ quy tắc của lớp, không gộp với giá trị cũ). */
export const feeRulesInputSchema = z
  .object({
    chargeExcused: z.boolean().optional(),
    chargeUnexcused: z.boolean().optional(),
    deductCancelled: z.boolean().optional(),
    installments: z.int().min(1).max(36).optional(),
  })
  .meta({
    id: 'FeeRulesInput',
    description:
      'Thay toàn bộ quy tắc của lớp; trường thiếu lấy mặc định (`chargeExcused` và `chargeUnexcused` bật, `deductCancelled` tắt, `installments` 1). `installments` > 1 chỉ hợp lệ với `feeType = course`',
    example: { chargeExcused: false },
  });
export type FeeRulesInput = z.infer<typeof feeRulesInputSchema>;

/** Học phí cơ sở của lớp: số nguyên đồng > 0 (US-1.2 AC3). Không bắt buộc là bội của 1.000. */
export const feeAmountSchema = z.int().min(1).max(1_000_000_000).meta({
  description:
    'VND, số nguyên > 0: đơn giá buổi (`per_session`), học phí tháng (`monthly`) hoặc tổng tiền khóa (`course`)',
  example: 150000,
});

// ---- Kỳ thu ----

export const invoiceStatusSchema = z
  .enum([
    'draft',
    'issued',
    'pending_confirmation',
    'partially_paid',
    'paid',
    'void',
  ])
  .meta({
    id: 'InvoiceStatus',
    description:
      'Sprint 5 phát sinh `draft`, `issued`, `void`. Sprint 6 thêm `partially_paid` (0 < Σ thanh toán chưa hủy < `totalAmount`) và `paid` (Σ ≥ `totalAmount`); hủy thanh toán tính lại từ Σ còn hiệu lực (về `issued` khi Σ = 0). `pending_confirmation` (phụ huynh báo đã chuyển khoản, US-7.7) chưa phát sinh ở Sprint 6; client coi giá trị lạ như `issued`.',
  });

export const billingPeriodStatusSchema = z.enum(['drafting', 'closed']).meta({
  id: 'BillingPeriodStatus',
  description:
    '`drafting` = còn bản nháp có tiền chưa chốt, `closed` = không còn bản nháp nào có số tiền > 0 (bản nháp 0 đ có thể còn lại, không gửi)',
});

export const billingPeriodSchema = z
  .object({
    id: z.uuid(),
    periodMonth: z.iso.date().meta({
      description: 'Ngày 1 của tháng thu (kỳ mặc định là tháng dương lịch)',
      example: '2026-12-01',
    }),
    closeDate: z.iso
      .date()
      .meta({ description: 'Ngày chốt (tác vụ nền tạo bản nháp)' }),
    dueDate: z.iso.date().meta({
      description: 'Hạn thanh toán áp cho hóa đơn phát hành trong kỳ',
    }),
    status: billingPeriodStatusSchema,
    draftCount: z.int().min(0),
    issuedCount: z.int().min(0).meta({
      description:
        'Hóa đơn đã phát hành và chưa hủy (mọi trạng thái sau `draft`, trừ `void`)',
    }),
    voidCount: z.int().min(0),
    draftTotalAmount: vndSchema('Tổng tiền các bản nháp'),
    issuedTotalAmount: vndSchema(
      'Tổng tiền các hóa đơn đã phát hành, chưa hủy',
    ),
  })
  .meta({
    id: 'BillingPeriod',
    example: {
      id: '019c0a00-0001-7b30-8c01-000000000001',
      periodMonth: '2026-12-01',
      closeDate: '2026-12-31',
      dueDate: '2027-01-10',
      status: 'drafting',
      draftCount: 18,
      issuedCount: 0,
      voidCount: 0,
      draftTotalAmount: 21600000,
      issuedTotalAmount: 0,
    },
  });
export type BillingPeriod = z.infer<typeof billingPeriodSchema>;

export const billingPeriodListQuerySchema = pageQuerySchema.extend({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Tháng phải có dạng YYYY-MM.')
    .optional()
    .meta({ description: 'Chỉ kỳ của tháng này', example: '2026-12' }),
});
export type BillingPeriodListQuery = z.infer<
  typeof billingPeriodListQuerySchema
>;

export const billingPeriodPageSchema = paginatedSchema(
  billingPeriodSchema,
).meta({
  id: 'BillingPeriodPage',
});
export type BillingPeriodPage = z.infer<typeof billingPeriodPageSchema>;

// ---- Hóa đơn ----

const invoiceCode = z
  .string()
  .regex(/^TH-[0-9A-HJKMNP-TV-Z]{6}$/)
  .meta({
    description:
      'Mã hóa đơn duy nhất trong tenant, 6 ký tự Crockford (không I, L, O, U) sau `TH-`; null khi còn là bản nháp',
    example: 'TH-25K7Q9',
  });

const transferNote = z
  .string()
  .regex(/^TH [0-9A-HJKMNP-TV-Z]{6}$/)
  .meta({
    description:
      'Nội dung chuyển khoản = mã bỏ dấu gạch, thay bằng khoảng trắng (`TH 25K7Q9`): chỉ `[A-Z0-9 ]`, không dấu, ≤ 25 ký tự (US-7.3 AC3). Định dạng cố định để Giai đoạn 2 tự đối soát qua webhook',
    example: 'TH 25K7Q9',
  });

const qrPayload = z.string().max(512).meta({
  description:
    'Chuỗi VietQR chuẩn EMVCo/NAPAS sinh nội bộ bằng `buildVietQrPayload` (có CRC16): đã chứa số tiền `totalAmount` và nội dung `transferNote`. Client chỉ vẽ mã QR từ chuỗi này, không tự ghép',
});

/** Tài khoản nhận tiền chụp lúc phát hành: hóa đơn không đổi khi giáo viên sửa tài khoản về sau (Spec §4.8). */
export const payoutSnapshotSchema = z
  .object({
    bankBin: z.string().regex(/^\d{6}$/),
    bankName: z.string().nullable().meta({
      description:
        'Tên ngân hàng tra từ bảng BIN NAPAS của server lúc phát hành; null nếu BIN không có trong bảng (client hiện BIN)',
    }),
    accountNo: z.string(),
    accountName: z.string(),
  })
  .meta({ id: 'PayoutSnapshot' });

export const invoiceLineKindSchema = z
  .enum([
    'session',
    'monthly',
    'course_installment',
    'carry_over',
    'prev_adjustment',
    'discount',
    'surcharge',
    'manual_adjustment',
  ])
  .meta({
    id: 'InvoiceLineKind',
    description:
      'Sprint 5 sinh `session`, `monthly`, `course_installment`, `discount`, `manual_adjustment`. Sprint 6 sinh thêm `carry_over` (số dư chuyển kỳ, US-7.6) và `prev_adjustment` (chênh lệch điểm danh sửa sau phát hành, US-7.6 AC3); `surcharge` cần US-7.8 (P1). Client coi giá trị lạ như dòng thường',
  });

export const sessionNotChargedReasonSchema = z
  .enum(['excused_not_charged', 'unexcused_not_charged', 'cancelled', 'makeup'])
  .meta({
    id: 'SessionNotChargedReason',
    description:
      '`excused_not_charged`/`unexcused_not_charged` = lớp hoặc học viên tắt tính vắng có phép/không phép, `cancelled` = giáo viên hủy buổi, `makeup` = buổi bù không tính thêm tiền (US-7.1 AC3). Ứng với `reason` của `InvoiceCalculator` (trừ `taught`, nghĩa là có tính). ' +
      'Chưa có lý do riêng cho buổi chưa điểm danh lúc chốt (issue #179): thêm `not_marked` vào enum bị `oasdiff` coi là breaking (`response-property-enum-value-added`), nên chờ Owner/TL chọn ngoại lệ, xem `contracts/CHANGELOG.md`. Client coi giá trị lạ như "không tính"',
  });

export const invoiceLineSchema = z
  .object({
    id: z.uuid(),
    kind: invoiceLineKindSchema,
    description: z.string(),
    amount: signedVndSchema(
      'Có dấu: giảm trừ, miễn giảm và điều chỉnh giảm là số âm; dòng buổi không tính tiền là 0',
    ),
    charged: z.boolean().meta({
      description:
        'Dòng `session`: buổi có tính tiền không. Mọi loại dòng khác luôn `true`',
    }),
    notChargedReason: sessionNotChargedReasonSchema.nullable().meta({
      description: 'Có khi `kind = session` và `charged = false`, còn lại null',
    }),
    sessionId: z.uuid().nullable(),
    sessionDate: z.iso.date().nullable().meta({
      description: 'Ngày buổi học theo múi giờ tenant; có với dòng `session`',
    }),
    className: z.string().nullable().meta({
      description:
        'Lớp phát sinh dòng này (một hóa đơn gộp mọi lớp của học viên trong kỳ); null với dòng không thuộc lớp nào',
    }),
    adjustmentReason: z.string().nullable().meta({
      description:
        'Lý do của người sửa, bắt buộc và chỉ có với `manual_adjustment`; không liên quan lý do không tính của buổi',
    }),
  })
  .meta({
    id: 'InvoiceLine',
    description:
      '`lines` là nguồn duy nhất của hóa đơn và là SNAPSHOT lúc tính: mở hóa đơn không đọc lại điểm danh, và dòng không đổi sau phát hành (chênh lệch do sửa điểm danh về sau vào kỳ sau, `prev_adjustment`). Kiểu theo buổi: mỗi buổi trong kỳ một dòng `session`, kể cả buổi hủy và buổi bù (0 đ). Kiểu theo tháng và trọn khóa: không có dòng buổi, một dòng gốc (`monthly` đã trừ phần buổi hủy nếu bật `deductCancelled`, hoặc `course_installment`), rồi các dòng `discount` và `manual_adjustment`. ' +
      'Sprint 6: dòng `carry_over` có `amount` có dấu (dương = "Nợ kỳ trước", âm = trừ tiền trả thừa), `className` null; dòng `prev_adjustment` ghi rõ buổi và số tiền chênh trong `description` (có `sessionId`/`sessionDate` khi chênh do một buổi). Cả hai là snapshot lúc tạo bản nháp, giáo viên không sửa được (chỉ thêm `manual_adjustment`)',
  });

export const invoiceSummarySchema = z
  .object({
    id: z.uuid(),
    code: invoiceCode.nullable(),
    status: invoiceStatusSchema,
    studentId: z.uuid(),
    studentName: z.string(),
    totalAmount: vndSchema('Tổng tiền = max(0, Σ `lines.amount`)'),
    hasOverride: z.boolean().meta({
      description:
        'Học viên có mức riêng ("Giá riêng") ở ít nhất một lớp trong kỳ',
    }),
  })
  .meta({
    id: 'InvoiceSummary',
    example: {
      id: '019c0a10-0001-7b30-8c01-000000000001',
      code: null,
      status: 'draft',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      studentName: 'Nguyễn Minh Anh',
      totalAmount: 1200000,
      hasOverride: false,
    },
  });

export const billingPeriodDetailQuerySchema = pageQuerySchema.extend({
  status: invoiceStatusSchema
    .optional()
    .meta({ description: 'Lọc theo trạng thái hóa đơn' }),
});
export type BillingPeriodDetailQuery = z.infer<
  typeof billingPeriodDetailQuerySchema
>;

export const billingPeriodDetailSchema = billingPeriodSchema
  .extend({ invoices: paginatedSchema(invoiceSummarySchema) })
  .meta({
    id: 'BillingPeriodDetail',
    description:
      'Tổng quan kỳ kèm danh sách hóa đơn (bản nháp và đã phát hành) phân trang, sắp theo tên học viên (T10)',
  });
export type BillingPeriodDetail = z.infer<typeof billingPeriodDetailSchema>;

export const invoiceSchema = z
  .object({
    id: z.uuid(),
    periodId: z.uuid(),
    periodMonth: z.iso.date(),
    code: invoiceCode.nullable(),
    transferNote: transferNote.nullable(),
    qrPayload: qrPayload.nullable(),
    status: invoiceStatusSchema,
    studentId: z.uuid(),
    studentName: z.string(),
    totalAmount: vndSchema(
      'Tổng tiền = max(0, Σ `lines.amount`, gồm cả dòng `carry_over`); phần âm không hấp thụ được chuyển kỳ sau (US-7.6, Sprint 6)',
    ),
    paidAmount: vndSchema(
      'Σ thanh toán chưa hủy của hóa đơn (Sprint 6); 0 khi chưa có. Có thể lớn hơn `totalAmount` khi trả thừa (phần thừa vào sổ học viên, US-7.6)',
    ),
    remainingAmount: vndSchema(
      '0 khi `status` là `void` (hóa đơn hủy, không còn phải trả) hoặc `draft` (chưa phát hành); các trạng thái khác = max(0, `totalAmount` − `paidAmount`). Còn nợ 700.000 đ trên hóa đơn 1.200.000 đ đã thu 500.000 đ (US-7.4 AC2)',
    ),
    dueDate: z.iso.date(),
    issuedAt: z.iso.datetime({ offset: true }).nullable(),
    payout: payoutSnapshotSchema
      .nullable()
      .meta({ description: 'Null khi còn là bản nháp' }),
    voidedAt: z.iso.datetime({ offset: true }).nullable(),
    voidReason: z.string().nullable(),
    replacesInvoiceId: z.uuid().nullable().meta({
      description:
        'Bản nháp được tạo để thay hóa đơn đã hủy (xem `POST /invoices/{id}/void`)',
    }),
    replacementInvoiceId: z.uuid().nullable().meta({
      description: 'Có khi hóa đơn này đã hủy kèm bản nháp thay thế',
    }),
    lines: z.array(invoiceLineSchema),
    installmentNo: z.int().min(1).max(36).nullable().meta({
      description:
        'Kiểu trọn khóa: đợt của hóa đơn này (n trong n/`installmentCount`). Đợt n là kỳ thứ n kể từ kỳ đầu tiên học viên vào lớp; hết đợt thì kỳ sau không sinh hóa đơn trọn khóa cho ghi danh đó. Null với kiểu khác',
    }),
    installmentCount: z.int().min(1).max(36).nullable(),
    clampedAmount: vndSchema(
      'Phần âm bị cắt khi Σ `lines.amount` < 0 để `totalAmount` không âm; 0 khi không cắt. Từ Sprint 6 phần này chuyển kỳ sau thành dòng `carry_over` âm (US-7.6 AC4)',
    ),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: 'Invoice',
    description:
      'Hóa đơn của giáo viên. Từ khi rời `draft`, mọi cột tiền bất biến (trigger CSDL): sửa `totalAmount` hay dòng → 409 `INVOICE_IMMUTABLE`',
    example: {
      id: '019c0a10-0001-7b30-8c01-000000000001',
      periodId: '019c0a00-0001-7b30-8c01-000000000001',
      periodMonth: '2026-12-01',
      code: null,
      transferNote: null,
      qrPayload: null,
      status: 'draft',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      studentName: 'Nguyễn Minh Anh',
      totalAmount: 150000,
      paidAmount: 0,
      remainingAmount: 150000,
      dueDate: '2027-01-10',
      issuedAt: null,
      payout: null,
      voidedAt: null,
      voidReason: null,
      replacesInvoiceId: null,
      replacementInvoiceId: null,
      installmentNo: null,
      installmentCount: null,
      clampedAmount: 0,
      lines: [
        {
          id: '019c0a11-0001-7b30-8c01-000000000001',
          kind: 'session',
          description: 'Buổi 2026-12-15',
          amount: 150000,
          charged: true,
          notChargedReason: null,
          sessionId: '019b2c41-0001-7a10-8a01-000000000001',
          sessionDate: '2026-12-15',
          className: 'Toán 9A',
          adjustmentReason: null,
        },
        {
          id: '019c0a11-0001-7b30-8c01-000000000002',
          kind: 'session',
          description: 'Buổi 2026-12-17 (không tính)',
          amount: 0,
          charged: false,
          notChargedReason: 'excused_not_charged',
          sessionId: '019b2c41-0001-7a10-8a01-000000000002',
          sessionDate: '2026-12-17',
          className: 'Toán 9A',
          adjustmentReason: null,
        },
      ],
      createdAt: '2026-12-31T02:00:00+07:00',
    },
  });
export type Invoice = z.infer<typeof invoiceSchema>;

// ---- Điều chỉnh ----

export const createAdjustmentRequestSchema = z
  .object({
    amount: z
      .int()
      .min(-1_000_000_000)
      .max(1_000_000_000)
      .refine((v) => v !== 0, 'Số tiền điều chỉnh phải khác 0.')
      .meta({
        description:
          'VND có dấu, ≠ 0: âm = giảm trừ, dương = phụ thu. Giữ nguyên số nhập, không làm tròn 1.000 đ',
        example: -100000,
      }),
    description: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .meta({ example: 'Giảm học phí buổi học thử' }),
    adjustmentReason: z
      .string()
      .trim()
      .min(1, 'Vui lòng nhập lý do điều chỉnh.')
      .max(300)
      .meta({
        description:
          'Bắt buộc (US-7.2 AC3); ghi nhật ký kiểm toán cùng người sửa và giá trị trước/sau',
      }),
  })
  .meta({
    id: 'CreateInvoiceAdjustmentRequest',
    example: {
      amount: -100000,
      description: 'Giảm học phí buổi học thử',
      adjustmentReason: 'Buổi 05/12 học thử, đã thỏa thuận với phụ huynh',
    },
  });
export type CreateAdjustmentRequest = z.infer<
  typeof createAdjustmentRequestSchema
>;

// ---- Phát hành ----

export const issueInvoicesRequestSchema = z
  .object({
    invoiceIds: z.array(z.uuid()).min(1).max(500).nullable().meta({
      description:
        'null = "Chốt & gửi tất cả" bản nháp của kỳ; mảng = chốt từng hóa đơn đã chọn (US-7.2 AC4). Bắt buộc có, kể cả null',
    }),
  })
  .meta({
    id: 'IssueInvoicesRequest',
    example: { invoiceIds: null },
  });
export type IssueInvoicesRequest = z.infer<typeof issueInvoicesRequestSchema>;

export const issuedInvoiceSchema = z
  .object({
    id: z.uuid(),
    code: invoiceCode,
    studentId: z.uuid(),
    studentName: z.string(),
    totalAmount: vndSchema(
      'VND, > 0 (hóa đơn 0 đ không bao giờ được phát hành)',
    ),
    dueDate: z.iso.date(),
    transferNote,
    qrPayload,
  })
  .meta({ id: 'IssuedInvoice' });

export const issueSkippedSchema = z
  .object({
    invoiceId: z.uuid(),
    studentName: z.string(),
    reason: z.enum(['ZERO_AMOUNT', 'NOT_DRAFT']).meta({
      description:
        '`ZERO_AMOUNT` = hóa đơn 0 đ, không gửi và không nhắc nợ (US-1.3 AC3, bản nháp vẫn còn). `NOT_DRAFT` = đã phát hành hoặc đã hủy từ trước (chỉ gặp khi chọn `invoiceIds`)',
    }),
  })
  .meta({ id: 'IssueSkipped' });

export const issueInvoicesResultSchema = z
  .object({
    issuedCount: z.int().min(0),
    skipped: z.array(issueSkippedSchema),
    totalAmount: vndSchema('Tổng tiền các hóa đơn vừa phát hành'),
    invoices: z.array(issuedInvoiceSchema),
  })
  .meta({
    id: 'IssueInvoicesResult',
    example: {
      issuedCount: 1,
      skipped: [
        {
          invoiceId: '019c0a10-0001-7b30-8c01-000000000009',
          studentName: 'Trần Gia Bảo',
          reason: 'ZERO_AMOUNT',
        },
      ],
      totalAmount: 1200000,
      invoices: [
        {
          id: '019c0a10-0001-7b30-8c01-000000000001',
          code: 'TH-25K7Q9',
          studentId: '019b2c4f-0001-7b30-8c01-000000000001',
          studentName: 'Nguyễn Minh Anh',
          totalAmount: 1200000,
          dueDate: '2027-01-10',
          transferNote: 'TH 25K7Q9',
          qrPayload:
            '00020101021238570010A000000727012700069704360113…5303704540712000005802VN62130809TH 25K7Q96304A1B2',
        },
      ],
    },
  });
export type IssueInvoicesResult = z.infer<typeof issueInvoicesResultSchema>;

// ---- Hủy ----

export const voidInvoiceRequestSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, 'Vui lòng nhập lý do hủy.')
      .max(300)
      .meta({ description: 'Bắt buộc (US-7.3 AC4); ghi nhật ký kiểm toán' }),
    createReplacementDraft: z.boolean().default(false).meta({
      description:
        'Chưa hỗ trợ ở MVP: gửi `true` → 422 `VALIDATION_FAILED` (hóa đơn không bị hủy). Muốn hóa đơn thay thế: hủy hóa đơn rồi tạo lại bản nháp và chốt như bình thường (Plan §2.6)',
    }),
  })
  .meta({
    id: 'VoidInvoiceRequest',
    example: { reason: 'Sai số buổi học' },
  });
export type VoidInvoiceRequest = z.infer<typeof voidInvoiceRequestSchema>;

export const voidInvoiceResultSchema = z
  .object({
    invoice: invoiceSchema,
    replacementInvoiceId: z.uuid().nullable().meta({
      description:
        'Luôn null ở MVP (chưa có hóa đơn thay thế); giữ trường để thêm sau mà không đổi hợp đồng',
    }),
  })
  .meta({ id: 'VoidInvoiceResult' });
export type VoidInvoiceResult = z.infer<typeof voidInvoiceResultSchema>;

// ---- Phụ huynh (P03): dữ liệu đã lọc, không có lý do nội bộ, lớp/buổi chi tiết hay học viên khác ----

export const familyInvoiceSummarySchema = z
  .object({
    id: z.uuid(),
    code: invoiceCode,
    status: invoiceStatusSchema.exclude(['draft']),
    studentId: z.uuid(),
    studentName: z.string(),
    teacherName: z.string(),
    periodMonth: z.iso.date(),
    totalAmount: vndSchema('VND'),
    paidAmount: vndSchema(
      'Σ thanh toán chưa hủy (Sprint 6); 0 khi chưa có. Có thể lớn hơn `totalAmount` khi trả thừa',
    ),
    remainingAmount: vndSchema(
      '0 khi `status = void`; các trạng thái khác = max(0, `totalAmount` − `paidAmount`) (P03: "Còn nợ" khi `issued` hoặc `partially_paid`)',
    ),
    dueDate: z.iso.date(),
    issuedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: 'FamilyInvoiceSummary',
    example: {
      id: '019c0a10-0001-7b30-8c01-000000000001',
      code: 'TH-25K7Q9',
      status: 'issued',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      studentName: 'Nguyễn Minh Anh',
      teacherName: 'Cô Lan',
      periodMonth: '2026-12-01',
      totalAmount: 1200000,
      paidAmount: 0,
      remainingAmount: 1200000,
      dueDate: '2027-01-10',
      issuedAt: '2027-01-02T09:00:00+07:00',
    },
  });

export const familyInvoicesQuerySchema = cursorQuerySchema(50).extend({
  status: invoiceStatusSchema.exclude(['draft']).optional().meta({
    description: 'Lọc theo trạng thái; bỏ trống = mọi trạng thái trừ `draft`',
  }),
  studentId: z.uuid().optional().meta({
    description:
      'Chỉ hóa đơn của con này; con không liên kết cho danh sách rỗng',
  }),
});
export type FamilyInvoicesQuery = z.infer<typeof familyInvoicesQuerySchema>;

export const familyInvoiceListSchema = cursorPageSchema(
  familyInvoiceSummarySchema,
).meta({
  id: 'FamilyInvoiceList',
  description:
    'Hóa đơn của các con đã liên kết, mới phát hành trước, phân trang con trỏ. Không bao giờ có bản nháp. Hóa đơn đã hủy vẫn có (`status = void`) để link cũ hiện "đã hủy" chứ không 404',
});
export type FamilyInvoiceList = z.infer<typeof familyInvoiceListSchema>;

export const familyInvoiceLineSchema = z
  .object({
    kind: invoiceLineKindSchema,
    className: z.string().nullable(),
    description: z.string(),
    amount: signedVndSchema('Có dấu như `InvoiceLine.amount`'),
  })
  .meta({ id: 'FamilyInvoiceLine' });

export const paymentMethodSchema = z.enum(['bank_transfer', 'cash']).meta({
  id: 'PaymentMethod',
  description: '`bank_transfer` = chuyển khoản, `cash` = tiền mặt (US-7.4 AC1)',
});

/** Biên nhận cho phụ huynh (US-7.4 AC3): một thanh toán, đã lọc bỏ lý do hủy và ghi chú nội bộ của giáo viên. */
export const familyPaymentSchema = z
  .object({
    id: z.uuid(),
    amount: vndSchema('VND, > 0'),
    method: paymentMethodSchema,
    paidOn: z.iso.date().meta({ description: 'Ngày thu giáo viên ghi' }),
    recordedAt: z.iso.datetime({ offset: true }),
    voidedAt: z.iso.datetime({ offset: true }).nullable().meta({
      description:
        'Khác null khi giáo viên hủy thanh toán (ghi nhầm): biên nhận hiện "đã hủy", không tính vào `paidAmount`. Không có lý do hủy',
    }),
  })
  .meta({
    id: 'FamilyPayment',
    example: {
      id: '019c0b20-0001-7b30-8c01-000000000001',
      amount: 500000,
      method: 'bank_transfer',
      paidOn: '2027-01-05',
      recordedAt: '2027-01-05T09:12:00+07:00',
      voidedAt: null,
    },
  });

export const familyInvoiceSchema = familyInvoiceSummarySchema
  .extend({
    lines: z.array(familyInvoiceLineSchema),
    payments: z.array(familyPaymentSchema).meta({
      description:
        'Biên nhận của hóa đơn, mới nhất trước, gồm cả thanh toán đã hủy (`voidedAt` ≠ null); rỗng khi chưa thu. Phụ huynh nhận thông báo `payment_recorded` trong ≤ 1 phút sau khi giáo viên ghi (US-7.4 AC3) rồi mở màn này làm biên nhận. Chỉ phụ huynh đã liên kết với con mới xem được; hóa đơn của con người khác → 404 `NOT_FOUND`. Không có `recordedBy`/`voidedBy` (chỉ giáo viên thấy)',
    }),
    transferNote,
    qrPayload: qrPayload.nullable().meta({
      description:
        'Null khi `status = void` (không được chuyển khoản vào hóa đơn đã hủy)',
    }),
    payout: payoutSnapshotSchema.nullable().meta({
      description:
        'Tài khoản nhận tiền; null khi `status = void` (không còn nơi để chuyển khoản)',
    }),
    voidedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({
    id: 'FamilyInvoice',
    description:
      'Chi tiết hóa đơn cho phụ huynh (P03): kỳ, dòng, tổng tiền, hạn, tài khoản nhận, VietQR (US-7.3 AC1), biên nhận thanh toán (US-7.4 AC3). Không có lý do hủy hay lý do điều chỉnh của giáo viên. Khi `status = paid` client ẩn mã QR dù `qrPayload` vẫn có',
  });
export type FamilyInvoice = z.infer<typeof familyInvoiceSchema>;
