import { z } from 'zod';
import { pageQuerySchema, paginatedSchema } from '@teachhub/core';

const dateTime = z.iso.datetime({ offset: true });

// --- Chuyển khoản gói Pro (US-0.8 AC3) ---

export const bankTransferStatusSchema = z.enum(['pending', 'confirmed']);

const bankTransferOrderExample = {
  id: '019b2d00-0001-7c40-8d01-000000000001',
  tenantId: '019b2c10-0001-7a10-8a01-000000000001',
  tenantName: 'Cô Lan',
  amount: 250000,
  transferNote: 'TEACHHUB PRO CO LAN',
  status: 'pending',
  createdAt: '2026-12-20T10:15:00+07:00',
  bankTransactionRef: null,
  confirmedBy: null,
  confirmedAt: null,
  updatedAt: '2026-12-20T10:15:00+07:00',
};

export const bankTransferOrderSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    tenantName: z.string(),
    amount: z.int().min(0).meta({ description: 'Đồng' }),
    transferNote: z.string(),
    status: bankTransferStatusSchema,
    createdAt: dateTime,
    confirmedBy: z
      .string()
      .nullable()
      .meta({ description: '`x-admin-user-id` của người xác nhận' }),
    confirmedAt: dateTime.nullable(),
    bankTransactionRef: z.string().nullable().meta({
      description: 'Mã giao dịch ngân hàng admin đối chiếu khi xác nhận',
    }),
    updatedAt: dateTime.meta({
      description: 'Dùng làm `expectedUpdatedAt` khi xác nhận (khóa lạc quan)',
    }),
  })
  .meta({ id: 'BankTransferOrder', example: bankTransferOrderExample });

export type BankTransferOrder = z.infer<typeof bankTransferOrderSchema>;

export const bankTransferListQuerySchema = pageQuerySchema.extend({
  status: bankTransferStatusSchema.default('pending'),
});
export type BankTransferListQuery = z.infer<typeof bankTransferListQuerySchema>;

export const bankTransferOrderPageSchema = paginatedSchema(
  bankTransferOrderSchema,
).meta({
  id: 'BankTransferOrderPage',
  example: {
    items: [bankTransferOrderExample],
    total: 1,
    page: 1,
    pageSize: 20,
  },
});
export type BankTransferOrderPage = z.infer<typeof bankTransferOrderPageSchema>;

export const bankTransferConfirmedSchema = z
  .object({
    order: bankTransferOrderSchema,
    subscription: z.object({
      planCode: z.enum(['free', 'pro']),
      status: z.enum(['free', 'trialing', 'active', 'expired']),
      currentPeriodEnd: dateTime.nullable(),
    }),
  })
  .meta({
    id: 'BankTransferConfirmed',
    example: {
      order: {
        ...bankTransferOrderExample,
        status: 'confirmed',
        bankTransactionRef: 'FT26354123456',
        confirmedBy: 'iam-user-0042',
        confirmedAt: '2026-12-20T14:02:00+07:00',
        updatedAt: '2026-12-20T14:02:00+07:00',
      },
      subscription: {
        planCode: 'pro',
        status: 'active',
        currentPeriodEnd: '2027-12-20T14:02:00+07:00',
      },
    },
  });
export const confirmBankTransferRequestSchema = z
  .object({
    amount: z.int().min(0).meta({
      description: 'Số tiền (đồng) admin đã đối chiếu với sao kê',
      example: 250000,
    }),
    bankTransactionRef: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .meta({ example: 'FT26354123456' }),
    expectedUpdatedAt: dateTime.meta({
      description:
        '`updatedAt` của đơn lúc admin xem; lệch → 409 `CONFLICT_STALE`',
    }),
  })
  .meta({
    example: {
      amount: 250000,
      bankTransactionRef: 'FT26354123456',
      expectedUpdatedAt: '2026-12-20T10:15:00+07:00',
    },
  });
export type ConfirmBankTransferRequest = z.infer<
  typeof confirmBankTransferRequestSchema
>;

export type BankTransferConfirmed = z.infer<typeof bankTransferConfirmedSchema>;

// --- Thư viện quy định (US-9.6) ---

export const legalArticleStatusSchema = z.enum(['draft', 'published']);

const legalSource = z.object({
  title: z.string().trim().min(1).max(200),
  url: z
    .url()
    .max(2000)
    .refine((u) => u.startsWith('https://'), 'Liên kết phải dùng https.'),
});

const legalArticleExample = {
  id: '019b2d10-0001-7c40-8d01-000000000001',
  slug: 'cong-khai-mau-02',
  title: 'Công khai thông tin dạy thêm (Mẫu 02)',
  summary: 'Giáo viên dạy thêm ngoài nhà trường phải niêm yết Mẫu 02.',
  bodyMarkdown: '## Ai phải công khai?\n\nGiáo viên tổ chức dạy thêm...',
  sources: [
    {
      title: 'Thông tư 29/2024/TT-BGDĐT',
      url: 'https://thuvienphapluat.vn/van-ban/Giao-duc/Thong-tu-29-2024-TT-BGDDT-410148.aspx',
    },
  ],
  version: 1,
  status: 'draft',
  reviewedBy: null,
  reviewerRole: null,
  reviewedOn: null,
  publishedBy: null,
  publishedAt: null,
  updatedAt: '2026-12-20T09:00:00+07:00',
};

export const legalArticleSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    bodyMarkdown: z.string(),
    sources: z.array(legalSource),
    version: z.int().min(1),
    status: legalArticleStatusSchema,
    reviewedBy: z.string().nullable().meta({
      description: 'Nhãn văn bản thuần (plain text), không render HTML',
    }),
    reviewerRole: z.enum(['lawyer', 'accountant']).nullable(),
    reviewedOn: z.iso.date().nullable(),
    publishedBy: z.string().nullable().meta({
      description:
        '`x-admin-user-id` của người phát hành; server ghi, không nhận từ body',
    }),
    publishedAt: dateTime.nullable(),
    updatedAt: dateTime,
  })
  .meta({ id: 'LegalArticle', example: legalArticleExample });
export type LegalArticle = z.infer<typeof legalArticleSchema>;

export const createLegalArticleRequestSchema = z
  .object({
    slug: z
      .string()
      .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        'Slug chỉ gồm chữ thường, số và dấu gạch ngang.',
      )
      .max(120),
    title: z.string().trim().min(1, 'Vui lòng nhập tiêu đề.').max(200),
    summary: z.string().trim().min(1, 'Vui lòng nhập tóm tắt.').max(1000),
    bodyMarkdown: z
      .string()
      .min(1, 'Vui lòng nhập nội dung.')
      .max(50_000)
      .meta({
        description: 'Markdown; khi hiển thị không cho phép HTML thô',
      }),
    sources: z
      .array(legalSource)
      .min(1, 'Cần ít nhất một văn bản gốc.')
      .max(20),
  })
  .meta({
    example: {
      slug: legalArticleExample.slug,
      title: legalArticleExample.title,
      summary: legalArticleExample.summary,
      bodyMarkdown: legalArticleExample.bodyMarkdown,
      sources: legalArticleExample.sources,
    },
  });
export type CreateLegalArticleRequest = z.infer<
  typeof createLegalArticleRequestSchema
>;

export const publishLegalArticleRequestSchema = z
  .object({
    reviewedBy: z
      .string()
      .trim()
      .min(1, 'Vui lòng nhập tên người duyệt.')
      .max(120)
      .meta({
        description: 'Nhãn văn bản thuần (plain text), không render HTML',
        example: 'LS. Trần Thị Mai',
      }),
    reviewerRole: z.enum(['lawyer', 'accountant']),
    reviewedOn: z.iso.date().meta({ example: '2026-12-19' }),
  })
  .meta({
    example: {
      reviewedBy: 'LS. Trần Thị Mai',
      reviewerRole: 'lawyer',
      reviewedOn: '2026-12-19',
    },
  });
export type PublishLegalArticleRequest = z.infer<
  typeof publishLegalArticleRequestSchema
>;

export const legalArticleListQuerySchema = pageQuerySchema.extend({
  status: legalArticleStatusSchema.optional(),
});
export type LegalArticleListQuery = z.infer<typeof legalArticleListQuerySchema>;

export const legalArticlePageSchema = paginatedSchema(legalArticleSchema).meta({
  id: 'LegalArticlePage',
  example: { items: [legalArticleExample], total: 1, page: 1, pageSize: 20 },
});
export type LegalArticlePage = z.infer<typeof legalArticlePageSchema>;

// --- Tra cứu hỗ trợ ---

export const supportTenantSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    type: z.enum(['teacher', 'center', 'chain']),
    timezone: z.string(),
    createdAt: dateTime,
    owner: z
      .object({
        userId: z.uuid(),
        email: z.string(),
        displayName: z.string().nullable(),
      })
      .nullable(),
    subscription: z.object({
      planCode: z.enum(['free', 'pro']),
      status: z.enum(['free', 'trialing', 'active', 'expired']),
      source: z.enum(['app_store', 'play_store', 'bank_transfer']).nullable(),
      currentPeriodEnd: dateTime.nullable(),
      trialUsedAt: dateTime.nullable(),
    }),
    usage: z.object({
      activeClasses: z.int().min(0),
      activeStudents: z.int().min(0),
    }),
  })
  .meta({
    id: 'SupportTenant',
    example: {
      id: '019b2c10-0001-7a10-8a01-000000000001',
      name: 'Cô Lan',
      type: 'teacher',
      timezone: 'Asia/Ho_Chi_Minh',
      createdAt: '2026-12-14T09:00:00+07:00',
      owner: {
        userId: '019a8f3e-7c1b-7d2a-9b3e-5f6a7b8c9d0e',
        email: 'co.lan@example.com',
        displayName: 'Cô Lan',
      },
      subscription: {
        planCode: 'free',
        status: 'free',
        source: null,
        currentPeriodEnd: null,
        trialUsedAt: null,
      },
      usage: { activeClasses: 2, activeStudents: 14 },
    },
  });
export type SupportTenant = z.infer<typeof supportTenantSchema>;
