import { z } from 'zod';
import {
  guardianInviteStatusSchema,
  latestInviteSchema,
  pageQuerySchema,
  paginatedSchema,
} from '@teachhub/core';
import {
  feeAmountSchema,
  feeRulesInputSchema,
  feeRulesSchema,
  feeTypeSchema,
} from '@teachhub/modules/billing';
import { scheduleRuleSchema } from '@teachhub/modules/schedule';
import { vndSchema } from '@teachhub/core';

// Học phí (US-1.2) có từ Sprint 5, chỉ đặt qua `PATCH /classes/{id}` (tạo lớp chưa nhận học phí). Cảnh báo TT29 (US-9.3) thêm sau.

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
    description:
      'Không bắt buộc, kể cả lớp `offline` (onboarding tạo lớp chưa có địa điểm, nhập sau ở Cài đặt lớp)',
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
      message: 'Ngày kết thúc không được trước ngày bắt đầu.',
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

/** Học phí trong PATCH (US-1.2). `feeType` và `feeAmount` cùng đặt hoặc cùng xóa; gửi riêng một trường thì server kiểm trên bản đã gộp. */
const feeUpdateFields = {
  feeType: feeTypeSchema.nullable().optional().meta({
    description:
      'Kiểu tính học phí; `null` cùng với `feeAmount = null` xóa cấu hình học phí của lớp (lớp chưa có học phí không sinh bản nháp hóa đơn). `course` chỉ hợp lệ khi lớp xác định được tổng số buổi của khóa: có `endDate` và ít nhất một quy tắc lịch (tổng buổi = số buổi theo lịch từ `startDate` đến `endDate`, trừ ngày lễ bỏ qua); thiếu → 422 `VALIDATION_FAILED` ở `feeType`',
  }),
  feeAmount: feeAmountSchema.nullable().optional(),
  feeRules: feeRulesInputSchema.nullable().optional().meta({
    description:
      'Thay toàn bộ quy tắc (xem `FeeRulesInput`); `null` = về mặc định. Chỉ hợp lệ khi lớp có học phí sau khi gộp',
  }),
};

/**
 * Chỉ gửi trường đổi. Quy tắc "tại chỗ phải có địa điểm" server kiểm trên bản đã gộp.
 * Học phí: đổi cấu hình chỉ áp dụng từ kỳ chưa chốt tiếp theo, hóa đơn đã phát hành không đổi (US-1.2 AC4).
 */
export const updateClassRequestSchema = classFields
  .partial()
  .extend(feeUpdateFields)
  .superRefine((v, ctx) => {
    endAfterStart(v, ctx);
    if (v.feeType === null && v.feeAmount != null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Không đặt số tiền khi bỏ kiểu học phí.',
        path: ['feeAmount'],
      });
    }
    if (v.feeAmount === null && v.feeType != null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Vui lòng nhập số tiền học phí.',
        path: ['feeAmount'],
      });
    }
    if (
      v.feeRules?.installments !== undefined &&
      v.feeRules.installments > 1 &&
      v.feeType != null &&
      v.feeType !== 'course'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Chỉ khóa trọn gói mới chia đợt.',
        path: ['feeRules', 'installments'],
      });
    }
  })
  .meta({
    example: {
      feeType: 'per_session',
      feeAmount: 150000,
      feeRules: { chargeExcused: false },
    },
  });
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
  feeType: 'per_session',
  feeAmount: 150000,
  feeRules: {
    chargeExcused: true,
    chargeUnexcused: true,
    deductCancelled: false,
    installments: 1,
  },
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
    feeType: feeTypeSchema.nullable().meta({
      description:
        'Null = lớp chưa cấu hình học phí (lớp cũ trước Sprint 5): không sinh hóa đơn cho lớp này',
    }),
    feeAmount: feeAmountSchema.nullable(),
    feeRules: feeRulesSchema.nullable().meta({
      description:
        'Quy tắc hiệu lực khi có học phí (đã điền mặc định), null khi không có học phí',
    }),
    scheduleRules: z.array(scheduleRuleSchema),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'Class', example: classExample });
export type Class = z.infer<typeof classSchema>;

/** Phản hồi POST /classes: lớp trần + cảnh báo không chặn (mặc định rỗng; TT29, trùng giờ… thêm sau). */
export const classCreatedSchema = classSchema
  .extend({
    warnings: z
      .array(z.object({ code: z.string(), message: z.string() }))
      .default([])
      .meta({ description: 'Cảnh báo không chặn; mặc định []' }),
  })
  .meta({
    id: 'ClassCreated',
    example: { ...classExample, warnings: [] },
  });
export type ClassCreated = z.infer<typeof classCreatedSchema>;

/** Cảnh báo không chặn của `POST /classes` (US-9.3): giáo viên xác nhận "Tôi đã hiểu, vẫn tạo" sau khi lớp đã được tạo. */
export const acknowledgeClassWarningRequestSchema = z
  .object({
    code: z.enum(['TT29_PRIMARY_ACADEMIC']).meta({
      description:
        '`TT29_PRIMARY_ACADEMIC` = lớp khối 1 đến 5 với môn văn hóa (US-9.3 AC1), trùng `warnings[].code` của `ClassCreated`. Môn nghệ thuật, thể thao, kỹ năng sống không có cảnh báo (US-9.3 AC2)',
    }),
  })
  .meta({
    id: 'AcknowledgeClassWarningRequest',
    example: { code: 'TT29_PRIMARY_ACADEMIC' },
  });
export type AcknowledgeClassWarningRequest = z.infer<
  typeof acknowledgeClassWarningRequestSchema
>;

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

const rosterGuardianSchema = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    relation: z.enum(['father', 'mother', 'guardian']),
    inviteStatus: guardianInviteStatusSchema,
    latestInvite: latestInviteSchema,
  })
  .meta({ id: 'RosterGuardian' });

const discountDescription = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .meta({ description: 'Tên khoản miễn giảm, hiện thành dòng `discount`' });

const discountSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('percent'),
      description: discountDescription,
      percent: z.int().min(1).max(100).meta({
        description:
          '100 = miễn giảm hoàn toàn (hóa đơn 0 đ không được gửi, US-1.3 AC3)',
      }),
    }),
    z.object({
      kind: z.literal('amount'),
      description: discountDescription,
      amount: z
        .int()
        .min(1)
        .max(1_000_000_000)
        .meta({ description: 'VND trừ mỗi kỳ, số nguyên > 0' }),
    }),
  ])
  .meta({
    id: 'FeeDiscount',
    description:
      'Miễn giảm định kỳ của học viên, áp mỗi kỳ cho đến khi gỡ. Phát sinh dòng hóa đơn `discount`; phần trăm tính trên phần học phí gốc của kỳ',
  });

/** Mức riêng của một ghi danh (US-1.3). Trường `null` = kế thừa từ lớp (thứ tự: học sinh > lớp > mặc định). */
export const feeOverrideSchema = z
  .object({
    feeAmount: vndSchema(
      'VND > 0, thay đơn giá buổi / học phí tháng / tổng khóa của lớp',
    )
      .min(1)
      .nullable(),
    chargeExcused: z
      .boolean()
      .nullable()
      .meta({ description: 'Ghi đè công tắc tính vắng có phép của lớp' }),
    chargeUnexcused: z
      .boolean()
      .nullable()
      .meta({ description: 'Ghi đè công tắc tính vắng không phép của lớp' }),
    deductCancelled: z
      .boolean()
      .nullable()
      .meta({ description: 'Ghi đè "trừ buổi hủy" của lớp (kiểu theo tháng)' }),
    installments: z.int().min(1).max(36).nullable().meta({
      description: 'Ghi đè số đợt của lớp trọn khóa (1 đến 36)',
    }),
    discounts: z.array(discountSchema).max(5).meta({
      description:
        'Tối đa 5 khoản miễn giảm định kỳ (Spec §4.4 `recurring_discounts`), mỗi khoản một dòng `discount`; rỗng = không miễn giảm. Với lớp trọn khóa chia đợt, khoản miễn giảm áp ở mỗi đợt, tính trên phần gốc của đợt đó',
    }),
  })
  .meta({
    id: 'FeeOverride',
    example: {
      feeAmount: 120000,
      chargeExcused: false,
      chargeUnexcused: null,
      deductCancelled: null,
      installments: null,
      discounts: [],
    },
  });
export type FeeOverride = z.infer<typeof feeOverrideSchema>;

export const putFeeOverrideRequestSchema = feeOverrideSchema.partial().meta({
  id: 'PutFeeOverrideRequest',
  description:
    'Thay toàn bộ mức riêng: trường thiếu hoặc `null` = kế thừa lớp, `discounts` thiếu hoặc rỗng = không miễn giảm. `{}` xóa mức riêng và bỏ nhãn "Giá riêng"',
  example: { feeAmount: 120000, chargeExcused: false },
});
export type PutFeeOverrideRequest = z.infer<typeof putFeeOverrideRequestSchema>;

export const feeOverrideResultSchema = z
  .object({
    enrollmentId: z.uuid(),
    studentId: z.uuid(),
    classId: z.uuid(),
    feeOverride: feeOverrideSchema.nullable().meta({
      description: 'Null khi mọi trường đều rỗng (không còn mức riêng)',
    }),
  })
  .meta({
    id: 'FeeOverrideResult',
    example: {
      enrollmentId: '019b2c50-0001-7b30-8c01-000000000001',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      classId: '019b2c3f-5e01-7c20-9b01-000000000001',
      feeOverride: {
        feeAmount: 120000,
        chargeExcused: false,
        chargeUnexcused: null,
        deductCancelled: null,
        installments: null,
        discounts: [],
      },
    },
  });
export type FeeOverrideResult = z.infer<typeof feeOverrideResultSchema>;

export const rosterSchema = z
  .object({
    items: z.array(
      z.object({
        enrollmentId: z.uuid(),
        studentId: z.uuid(),
        fullName: z.string(),
        studentStatus: z.enum(['active', 'paused']),
        joinedOn: z.iso.date(),
        inviteStatus: guardianInviteStatusSchema.meta({
          description:
            'Gộp theo các phụ huynh của học viên: `activated` nếu có ai đã nhận lời mời, không thì `invited` nếu có lời mời còn hạn, không thì `expired` nếu có lời mời hết hạn, còn lại `not_invited` (kể cả học viên chưa có phụ huynh)',
        }),
        guardians: z.array(rosterGuardianSchema).max(2),
        feeOverride: feeOverrideSchema.nullable().meta({
          description:
            'Khác null (có mức riêng, quy tắc vắng riêng hoặc miễn giảm) → hiện nhãn "Giá riêng" cạnh tên (US-1.3 AC2); null = theo cấu hình lớp',
        }),
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
          studentStatus: 'active',
          joinedOn: '2026-12-14',
          inviteStatus: 'invited',
          feeOverride: {
            feeAmount: 120000,
            chargeExcused: null,
            chargeUnexcused: null,
            deductCancelled: null,
            installments: null,
            discounts: [],
          },
          guardians: [
            {
              id: '019b2c4f-0002-7b30-8c01-000000000001',
              fullName: 'Nguyễn Văn Hải',
              relation: 'father',
              inviteStatus: 'invited',
              latestInvite: {
                id: '019b2c80-0001-7a10-8a01-000000000001',
                expiresAt: '2026-12-21T09:00:00+07:00',
              },
            },
          ],
        },
        {
          enrollmentId: '019b2c50-0001-7b30-8c01-000000000002',
          studentId: '019b2c4f-0001-7b30-8c01-000000000002',
          fullName: 'Trần Gia Bảo',
          studentStatus: 'active',
          joinedOn: '2026-12-14',
          inviteStatus: 'not_invited',
          feeOverride: null,
          guardians: [],
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
