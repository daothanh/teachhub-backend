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

export const createPayoutAccountRequestSchema = z
  .object({
    id: z.uuid().optional().meta({
      description: 'UUID do client sinh (tùy chọn); thiếu thì server sinh',
    }),
    bankBin,
    accountNo,
    accountName,
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
    isPrimary: z.literal(true).meta({
      description:
        'Chỉ nhận `true` (đặt làm tài khoản chính, tài khoản chính cũ bị bỏ cờ). Muốn bỏ cờ thì đặt tài khoản khác làm chính',
    }),
  })
  .partial()
  .meta({ example: { accountName: 'NGUYEN VAN B' } });
export type UpdatePayoutAccountRequest = z.infer<
  typeof updatePayoutAccountRequestSchema
>;

export const payoutAccountSchema = z
  .object({
    id: z.uuid(),
    bankBin: z.string().regex(/^\d{6}$/),
    accountNo: z.string(),
    accountName: z.string(),
    isPrimary: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: 'PayoutAccount',
    example: {
      id: '019c0a20-0001-7b30-8c01-000000000001',
      bankBin: '970436',
      accountNo: '0123456789',
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
