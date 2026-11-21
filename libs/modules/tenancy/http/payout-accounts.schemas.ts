import { z } from 'zod';

// Tài khoản nhận tiền học phí (Spec §4.4 `payout_accounts`). Hợp đồng Sprint 5 (S4-FL-10); thân hàm ở S5-BE-02.

const bankBin = z
  .string()
  .regex(/^\d{6}$/, 'Mã ngân hàng (BIN NAPAS) gồm đúng 6 chữ số.')
  .meta({
    description:
      'Mã BIN NAPAS 6 chữ số của ngân hàng (vd. Vietcombank `970436`). Server chỉ kiểm định dạng, không có danh mục ngân hàng: app/web giữ bảng BIN để chọn ngân hàng',
    example: '970436',
  });

const accountNo = z
  .string()
  .trim()
  .regex(/^\d{6,19}$/, 'Số tài khoản gồm 6 đến 19 chữ số.')
  .meta({ example: '0123456789' });

const accountName = z
  .string()
  .trim()
  .min(1, 'Vui lòng nhập tên chủ tài khoản.')
  .max(50)
  .meta({
    description: 'Tên chủ tài khoản như ngân hàng ghi',
    example: 'NGUYEN VAN A',
  });

const otpCode = z
  .string()
  .regex(/^\d{6}$/)
  .meta({
    description:
      'Mã OTP 6 số gửi tới email của user qua `POST /auth/otp/send` với `purpose = payout_account`. Bắt buộc khi đặt hoặc đổi `bankBin` hoặc `accountNo`, khi đặt một tài khoản khác làm chính (`isPrimary = true`) và khi xóa tài khoản chính còn tài khoản khác (chặn người cầm máy đổi nơi nhận tiền); sai → 401 `OTP_INVALID`, nhập sai quá nhiều → 429 `OTP_LOCKED`. Mã `payout_account` chỉ dùng được cho route này',
    example: '482913',
  });

export const createPayoutAccountRequestSchema = z
  .object({
    id: z.uuid().optional().meta({
      description: 'UUID do client sinh (tùy chọn); thiếu thì server sinh',
    }),
    bankBin,
    accountNo,
    accountName,
    otpCode,
    isPrimary: z.boolean().optional().meta({
      description:
        'Mặc định `true` với tài khoản đầu tiên, `false` với các tài khoản sau',
    }),
  })
  .meta({
    id: 'CreatePayoutAccountRequest',
    example: {
      bankBin: '970436',
      accountNo: '0123456789',
      accountName: 'NGUYEN VAN A',
      otpCode: '482913',
    },
  });
export type CreatePayoutAccountRequest = z.infer<
  typeof createPayoutAccountRequestSchema
>;

export const updatePayoutAccountRequestSchema = z
  .object({
    bankBin,
    accountNo,
    accountName,
    otpCode: otpCode.optional(),
    isPrimary: z.literal(true).meta({
      description:
        'Chỉ nhận `true` (đặt làm tài khoản chính, tài khoản chính cũ bị bỏ cờ). Muốn bỏ cờ thì đặt tài khoản khác làm chính',
    }),
  })
  .partial()
  .superRefine((v, ctx) => {
    if ((v.bankBin !== undefined || v.accountNo !== undefined) && !v.otpCode) {
      ctx.addIssue({
        code: 'custom',
        message: 'Đổi ngân hàng hoặc số tài khoản cần mã OTP.',
        path: ['otpCode'],
      });
    }
  })
  .meta({ example: { accountName: 'NGUYEN VAN B' } });
export type UpdatePayoutAccountRequest = z.infer<
  typeof updatePayoutAccountRequestSchema
>;

/** Body tùy chọn của DELETE: chỉ cần khi xóa tài khoản chính mà còn tài khoản khác. */
export const deletePayoutAccountRequestSchema = z
  .object({ otpCode: otpCode.optional() })
  .optional()
  .meta({
    id: 'DeletePayoutAccountRequest',
    description:
      'Xóa tài khoản chính khi còn tài khoản khác (chuyển nơi nhận tiền sang tài khoản khác) cần `otpCode`, thiếu → 422 `VALIDATION_FAILED`. Các trường hợp khác không cần body',
  });
export type DeletePayoutAccountRequest = z.infer<
  typeof deletePayoutAccountRequestSchema
>;

export const payoutAccountSchema = z
  .object({
    id: z.uuid(),
    bankBin: z.string().regex(/^\d{6}$/),
    accountNoMasked: z.string().meta({
      description:
        'Che số tài khoản, chỉ giữ 4 số cuối; số đầy đủ không trả lại qua API này, chỉ có trong `payout` của hóa đơn đã phát hành',
      example: '******6789',
    }),
    accountName: z.string(),
    isPrimary: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: 'PayoutAccount',
    example: {
      id: '019c0a20-0001-7b30-8c01-000000000001',
      bankBin: '970436',
      accountNoMasked: '******6789',
      accountName: 'NGUYEN VAN A',
      isPrimary: true,
      createdAt: '2027-01-20T09:30:00+07:00',
    },
  });
export type PayoutAccount = z.infer<typeof payoutAccountSchema>;

export const payoutAccountListSchema = z
  .object({ items: z.array(payoutAccountSchema) })
  .meta({
    id: 'PayoutAccountList',
    description: 'Tối đa 5 tài khoản mỗi tenant, không phân trang',
  });
export type PayoutAccountList = z.infer<typeof payoutAccountListSchema>;
