import { z } from 'zod';
import {
  paginatedSchema,
  pageQuerySchema,
  signedVndSchema,
  vndSchema,
} from '@teachhub/core';
import { feeTypeSchema } from '../../billing/http/billing.schemas.js';
import {
  reportMonthSchema,
  revenueEntrySchema,
} from '../../reports/http/reports.schemas.js';

// Hợp đồng Sprint 8 (S7-CT-01): tuân thủ pháp lý và thuế (E9, Spec §5.4 M9, T13). Chỉ `tenant_owner`, trừ trang công khai và thư viện quy định.
// Bảng `compliance_items`, `school_declarations`, `public_disclosures`, `tax_threshold_alerts`, `acknowledgements` (Spec §4.4); thân hàm ở task backend `compliance`.
// Mọi nội dung pháp lý/thuế hiển thị cho giáo viên phải qua bước duyệt luật sư/kế toán (US-9.6 AC3) và mang dòng "Công cụ hỗ trợ, không thay tư vấn pháp lý".

const dateTime = z.iso.datetime({ offset: true });

// ---- Checklist (US-9.1) ----

export const complianceItemKeySchema = z
  .enum([
    'business_registration',
    'registration_number',
    'public_disclosure',
    'school_declaration',
  ])
  .meta({
    id: 'ComplianceItemKey',
    description:
      '`business_registration` = đăng ký hộ kinh doanh; `registration_number` = lưu số giấy chứng nhận (có `data.registrationNo`); `public_disclosure` = công khai Mẫu 02 (tự `done` khi đang công khai); `school_declaration` = khai trường chính khóa (tự `done` khi đã khai, `not_applicable` khi khai "Không"). Client bỏ qua khóa lạ',
  });

export const complianceItemStatusSchema = z
  .enum(['todo', 'done', 'not_applicable'])
  .meta({
    id: 'ComplianceItemStatus',
    description:
      '`not_applicable` = không áp dụng, không tính vào % hoàn thành (chỉ `school_declaration` khi giáo viên khai không dạy ở trường, US-9.4 AC3). Client coi giá trị lạ như `todo`',
  });

export const complianceItemSchema = z
  .object({
    itemKey: complianceItemKeySchema,
    title: z.string(),
    description: z.string().meta({
      description:
        'Giải thích ngắn của mục (US-9.1 AC3), do server cấp để chỉnh nội dung không cần phát hành app',
    }),
    status: complianceItemStatusSchema,
    auto: z.boolean().meta({
      description:
        '`true` = trạng thái do hệ thống suy ra (`public_disclosure`, `school_declaration`), `PATCH` bị từ chối; người dùng làm ở màn tương ứng',
    }),
    data: z
      .object({
        registrationNo: z.string().max(50).optional(),
      })
      .nullable()
      .meta({
        description:
          'Dữ liệu nhập cho mục (vd. `registrationNo` của `registration_number`); null khi mục không có ô nhập hoặc chưa nhập',
      }),
    legalArticleSlug: z.string().nullable().meta({
      description:
        'Bài thư viện quy định liên quan (`GET /legal-articles/{slug}`, US-9.1 AC3); null nếu chưa có bài đã phát hành',
    }),
    completedAt: dateTime.nullable(),
  })
  .meta({ id: 'ComplianceItem' });

export const complianceChecklistSchema = z
  .object({
    items: z.array(complianceItemSchema),
    totalCount: z.int().min(0).meta({
      description: 'Số mục áp dụng (không tính `not_applicable`)',
    }),
    completedCount: z.int().min(0),
    percent: z.int().min(0).max(100).meta({
      description:
        '`completedCount` / `totalCount` làm tròn xuống, 0 khi `totalCount` = 0',
    }),
    nextItemKey: complianceItemKeySchema.nullable().meta({
      description:
        'Mục `todo` đầu tiên theo thứ tự `items` cho nút "Bước tiếp theo" (US-9.1 AC2); null khi đã xong hết. Gói Miễn phí dùng đủ chức năng (US-9.1 AC4)',
    }),
  })
  .meta({
    id: 'ComplianceChecklist',
    example: {
      items: [
        {
          itemKey: 'business_registration',
          title: 'Đăng ký hộ kinh doanh',
          description:
            'Giáo viên dạy thêm có thu phí cần đăng ký hộ kinh doanh.',
          status: 'done',
          auto: false,
          data: null,
          legalArticleSlug: 'dang-ky-ho-kinh-doanh',
          completedAt: '2026-12-01T09:00:00+07:00',
        },
        {
          itemKey: 'registration_number',
          title: 'Lưu số giấy chứng nhận',
          description: 'Nhập số giấy chứng nhận đăng ký hộ kinh doanh.',
          status: 'todo',
          auto: false,
          data: null,
          legalArticleSlug: null,
          completedAt: null,
        },
      ],
      totalCount: 4,
      completedCount: 1,
      percent: 25,
      nextItemKey: 'registration_number',
    },
  });
export type ComplianceChecklist = z.infer<typeof complianceChecklistSchema>;

export const updateChecklistItemRequestSchema = z
  .object({
    status: z.enum(['todo', 'done']),
    data: z
      .object({ registrationNo: z.string().trim().min(1).max(50) })
      .optional()
      .meta({
        description:
          '`registration_number` với `status = done` bắt buộc `data.registrationNo`; mục khác không nhận `data`. Sai → 422 `VALIDATION_FAILED`',
      }),
  })
  .meta({
    id: 'UpdateChecklistItemRequest',
    example: { status: 'done', data: { registrationNo: '01A8012345' } },
  });
export type UpdateChecklistItemRequest = z.infer<
  typeof updateChecklistItemRequestSchema
>;

// ---- Mẫu 02 công khai (US-9.2) ----

const classDisclosureFields = {
  className: z.string(),
  subject: z.string(),
  grade: z.int().min(1).max(12),
  scheduleSummary: z.string().nullable().meta({
    description:
      'Lịch học rút gọn do server soạn từ lịch lặp, vd. "T2, T4 18:00–19:30"; null khi lớp chưa có lịch',
  }),
  location: z.string().nullable(),
  feeType: feeTypeSchema.nullable(),
  feeAmount: z.int().min(1).max(1_000_000_000).nullable(),
  teacherName: z.string(),
};

export const form02MissingFieldSchema = z
  .object({
    classId: z
      .uuid()
      .nullable()
      .meta({ description: 'null = thiếu ở cấp cơ sở (vd. `teacherName`)' }),
    field: z.enum(['location', 'feeAmount', 'scheduleSummary', 'teacherName']),
    message: z.string(),
  })
  .meta({ id: 'Form02MissingField' });

export const form02RowSchema = z
  .object({
    classId: z.uuid(),
    ...classDisclosureFields,
  })
  .meta({ id: 'Form02Row' });

export const form02Schema = z
  .object({
    featureEnabled: z.boolean().meta({
      description:
        '`compliance.form02` của gói. `false` (Miễn phí): vẫn trả bảng điền sẵn để client làm mờ và mời nâng cấp (US-9.2 AC4); `POST .../publish` → 402 `FEATURE_REQUIRES_PRO`',
    }),
    teacherName: z.string(),
    businessRegNo: z
      .string()
      .nullable()
      .meta({ description: 'Số giấy chứng nhận lưu ở checklist' }),
    rows: z.array(form02RowSchema).meta({
      description:
        'Mỗi lớp `active` một dòng, điền từ dữ liệu lớp (US-9.2 AC1)',
    }),
    missing: z.array(form02MissingFieldSchema).meta({
      description:
        'Trường còn thiếu, chỉ rõ theo lớp (US-9.2 AC1); rỗng mới công khai được',
    }),
    canPublish: z
      .boolean()
      .meta({ description: '`rows` không rỗng và `missing` rỗng' }),
    isPublished: z.boolean(),
    slug: z.string().nullable().meta({
      description:
        'Đường dẫn cố định của trang công khai `/cong-khai/{slug}`, sinh một lần ở lần công khai đầu, không đổi khi tắt/bật lại (US-9.2 AC2); null khi chưa từng công khai',
    }),
    publicUrl: z
      .url()
      .nullable()
      .meta({
        description:
          'URL đầy đủ của trang công khai khi `isPublished`; null nếu không',
      }),
    pdfStatus: z.enum(['none', 'processing', 'ready', 'failed']).meta({
      description:
        'PDF A4 do worker sinh lên bucket `public` mỗi khi công khai hoặc dữ liệu lớp đổi',
    }),
    pdfUrl: z
      .url()
      .nullable()
      .meta({
        description:
          'URL công khai của PDF (`files.dayhoc.app`) khi `pdfStatus = ready` và `isPublished`',
      }),
    updatedAt: dateTime
      .nullable()
      .meta({
        description:
          'Ngày cập nhật bảng công khai (US-9.2 AC3); null khi chưa công khai',
      }),
  })
  .meta({ id: 'Form02' });
export type Form02 = z.infer<typeof form02Schema>;

export const publishForm02RequestSchema = z
  .object({
    published: z.boolean().default(true).meta({
      description:
        '`true` (mặc định) = bật công khai; `false` = tắt (trang công khai trả 404, PDF giữ nhưng không công khai)',
    }),
  })
  .meta({ id: 'PublishForm02Request', example: { published: true } });
export type PublishForm02Request = z.infer<typeof publishForm02RequestSchema>;

export const publicDisclosureSchema = z
  .object({
    slug: z.string(),
    providerName: z
      .string()
      .meta({
        description:
          'Tên cơ sở/người dạy, không có dữ liệu học viên hay phụ huynh',
      }),
    businessRegNo: z.string().nullable(),
    rows: z.array(z.object(classDisclosureFields)),
    pdfUrl: z.url().nullable(),
    updatedAt: dateTime.meta({
      description: '"Cập nhật ngày…" hiện trên trang (US-9.2 AC3)',
    }),
  })
  .meta({
    id: 'PublicDisclosure',
    description:
      'Dữ liệu trang `/cong-khai/:slug` (CK), không cần đăng nhập, chỉ chứa thông tin Mẫu 02 vốn phải niêm yết công khai',
  });
export type PublicDisclosure = z.infer<typeof publicDisclosureSchema>;

// ---- Khai trường chính khóa và Mẫu 03 (US-9.4) ----

export const schoolDeclarationSchema = z
  .object({
    teachesAtSchool: z.boolean().nullable().meta({
      description:
        'null = chưa khai; `false` = khai "Không" (ẩn Mẫu 03 và cảnh báo trùng, US-9.4 AC3)',
    }),
    schoolName: z.string().nullable(),
    schoolClasses: z
      .array(z.string())
      .meta({ description: 'Các lớp chính khóa đang dạy, vd. ["9A3", "9A4"]' }),
    updatedAt: dateTime.nullable(),
  })
  .meta({ id: 'SchoolDeclaration' });
export type SchoolDeclaration = z.infer<typeof schoolDeclarationSchema>;

export const putSchoolDeclarationRequestSchema = z
  .object({
    teachesAtSchool: z.boolean(),
    schoolName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .meta({
        description:
          'Bắt buộc khi `teachesAtSchool = true`; bị bỏ qua khi `false`',
      }),
    schoolClasses: z
      .array(z.string().trim().min(1).max(30))
      .max(20)
      .optional()
      .meta({
        description:
          'Ít nhất một lớp khi `teachesAtSchool = true`; bị bỏ qua khi `false`',
      }),
  })
  .meta({
    id: 'PutSchoolDeclarationRequest',
    description:
      'Thay toàn bộ khai báo (PUT, idempotent). Đặt `school_declaration` của checklist `done` hoặc `not_applicable`',
    example: {
      teachesAtSchool: true,
      schoolName: 'THCS Lê Lợi',
      schoolClasses: ['9A3', '9A4'],
    },
  });
export type PutSchoolDeclarationRequest = z.infer<
  typeof putSchoolDeclarationRequestSchema
>;

export const form03RowSchema = z
  .object({
    studentId: z.uuid(),
    fullName: z.string(),
    dob: z.iso.date().nullable(),
    school: z.string().nullable(),
    schoolClass: z.string().nullable(),
    classNames: z
      .array(z.string())
      .meta({ description: 'Các lớp đang ghi danh ở tenant này' }),
  })
  .meta({ id: 'Form03Row' });

export const form03Schema = z
  .object({
    featureEnabled: z
      .boolean()
      .meta({
        description:
          '`compliance.form03` của gói; `false` thì `POST /compliance/form03/pdf` → 402 `FEATURE_REQUIRES_PRO`',
      }),
    applicable: z
      .boolean()
      .meta({
        description:
          '`teachesAtSchool = true`. `false` (chưa khai hoặc khai "Không") thì `rows` rỗng và PDF bị từ chối',
      }),
    declaration: schoolDeclarationSchema,
    teacherName: z.string(),
    rows: z.array(form03RowSchema).meta({
      description:
        'Học viên `active` có `school` và `schoolClass` trùng khai báo (so khớp không phân biệt hoa thường và dấu), điền sẵn từ dữ liệu lớp và học viên (US-9.4 AC2). Cột chính xác của biểu mẫu do PDF quy định [Cần luật sư chốt mẫu]',
    }),
  })
  .meta({ id: 'Form03' });
export type Form03 = z.infer<typeof form03Schema>;

// ---- Sổ doanh thu và ngưỡng thuế (US-9.5) ----

export const revenueBookQuerySchema = pageQuerySchema.extend({
  year: z.coerce.number().int().min(2020).max(2100).optional().meta({
    description: 'Năm dương lịch theo múi giờ tenant; bỏ trống = năm hiện tại',
    example: 2026,
  }),
});
export type RevenueBookQuery = z.infer<typeof revenueBookQuerySchema>;

export const taxThresholdSchema = z
  .object({
    thresholdAmount: vndSchema(
      'Ngưỡng doanh thu năm: 500.000.000 hoặc 1.000.000.000 (US-9.5 AC2)',
    ),
    warnAmount: vndSchema(
      'Mốc cảnh báo = 80% ngưỡng: 400.000.000 hoặc 800.000.000 (US-9.5 AC3)',
    ),
    progressPercent: z.number().min(0).meta({
      description:
        '`cumulativeAmount` / `thresholdAmount` × 100, một chữ số thập phân, không chặn ở 100 (vượt ngưỡng thì > 100); 0 khi lũy kế âm. Client vẽ thanh tiến độ',
    }),
    status: z.enum(['below', 'warning', 'exceeded']).meta({
      description:
        '`below` < mốc cảnh báo; `warning` ≥ mốc cảnh báo và < ngưỡng; `exceeded` ≥ ngưỡng. Client coi giá trị lạ như `below`',
    }),
  })
  .meta({ id: 'TaxThreshold' });

export const taxAlertSchema = z
  .object({
    id: z.uuid(),
    milestone: z.enum(['400m', '800m']).meta({
      description:
        'Mốc đã vượt (`400m` = 80% của 500 triệu, `800m` = 80% của 1 tỷ). Mỗi (tenant, năm, mốc) chỉ một cảnh báo (`tax_threshold_alerts` unique, US-9.5 AC3)',
    }),
    warnAmount: vndSchema('Mốc cảnh báo (VND)'),
    thresholdAmount: vndSchema('Ngưỡng tương ứng (VND)'),
    cumulativeAmount: signedVndSchema(
      'Lũy kế ngay sau thanh toán làm vượt mốc',
    ),
    paymentId: z
      .uuid()
      .nullable()
      .meta({ description: 'Thanh toán làm vượt mốc' }),
    triggeredAt: dateTime,
    dismissedAt: dateTime
      .nullable()
      .meta({
        description:
          'Giáo viên đã đóng cảnh báo (`POST /compliance/tax-alerts/{id}/dismiss`); vẫn trả để xem lại',
      }),
    legalArticleSlug: z
      .string()
      .nullable()
      .meta({
        description:
          'Bài thư viện giải thích nghĩa vụ kèm cảnh báo (US-9.5 AC3); null nếu chưa có bài đã phát hành',
      }),
  })
  .meta({ id: 'TaxAlert' });

export const revenueBookSchema = z
  .object({
    year: z.int(),
    cumulativeAmount: signedVndSchema(
      'Doanh thu lũy kế cả năm = Σ `amount` của `revenue_ledger` có `fiscal_year` = `year`, gồm dòng đảo (US-9.5 AC1, AC2). Hủy thanh toán của năm trước không làm năm này giảm (dòng đảo mang ngày của khoản gốc)',
    ),
    monthly: z
      .array(
        z.object({
          month: reportMonthSchema,
          amount: signedVndSchema('Σ `amount` của tháng'),
        }),
      )
      .length(12)
      .meta({ description: '12 tháng của năm, T1 trước' }),
    thresholds: z
      .array(taxThresholdSchema)
      .length(2)
      .meta({
        description:
          'Hai ngưỡng theo thứ tự tăng dần (500 triệu, 1 tỷ). Gói Miễn phí cũng đầy đủ (US-9.5 AC4)',
      }),
    alerts: z
      .array(taxAlertSchema)
      .meta({ description: 'Cảnh báo đã phát sinh trong năm, mới trước' }),
    entries: paginatedSchema(revenueEntrySchema)
      .extend({
        totalAmount: signedVndSchema(
          'Σ `amount` của mọi dòng trong năm, bằng `cumulativeAmount`',
        ),
      })
      .meta({
        description:
          'Các dòng sổ (cùng dạng `RevenueEntry` của `GET /reports/payments`), mới trước, phân trang offset',
      }),
  })
  .meta({ id: 'RevenueBook' });
export type RevenueBook = z.infer<typeof revenueBookSchema>;

export const exportRevenueBookRequestSchema = z
  .object({
    year: z
      .int()
      .min(2020)
      .max(2100)
      .optional()
      .meta({ description: 'Bỏ trống = năm hiện tại' }),
    formats: z
      .array(z.enum(['xlsx', 'csv', 'pdf']))
      .min(1)
      .max(3)
      .default(['xlsx', 'pdf'])
      .meta({
        description: 'Mặc định `xlsx` và `pdf` (US-9.5 "xem, xuất PDF/Excel")',
      }),
  })
  .meta({
    id: 'ExportRevenueBookRequest',
    example: { year: 2026, formats: ['xlsx', 'pdf'] },
  });
export type ExportRevenueBookRequest = z.infer<
  typeof exportRevenueBookRequestSchema
>;

// ---- Thư viện quy định (US-9.6) ----

export const LEGAL_DISCLAIMER = 'Công cụ hỗ trợ, không thay tư vấn pháp lý';

export const legalArticleViewSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    bodyMarkdown: z.string(),
    sources: z
      .array(z.object({ title: z.string(), url: z.string().url() }))
      .meta({ description: 'Trích dẫn văn bản gốc kèm liên kết (US-9.6 AC1)' }),
    reviewedBy: z.string().nullable(),
    reviewerRole: z.enum(['lawyer', 'accountant']).nullable(),
    reviewedOn: z.iso.date().nullable(),
    disclaimer: z
      .string()
      .meta({ description: `Luôn là "${LEGAL_DISCLAIMER}" (US-9.6 AC1)` }),
    publishedAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({
    id: 'LegalArticleView',
    description:
      'Bài đã phát hành, dạng đọc cho giáo viên; không có trường soạn thảo của `LegalArticle` (admin)',
  });
export type LegalArticleView = z.infer<typeof legalArticleViewSchema>;

export const legalArticleViewListQuerySchema = pageQuerySchema.extend({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .meta({ description: 'Tìm trong tiêu đề và tóm tắt, không dấu' }),
});
export type LegalArticleViewListQuery = z.infer<
  typeof legalArticleViewListQuerySchema
>;

export const legalArticleViewPageSchema = paginatedSchema(
  legalArticleViewSchema,
).meta({ id: 'LegalArticleViewPage' });
export type LegalArticleViewPage = z.infer<typeof legalArticleViewPageSchema>;
