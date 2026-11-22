import { z } from 'zod';
import { reportMonthSchema } from './reports.schemas.js';

// Hợp đồng Sprint 8 (S7-CT-01): xuất tệp do worker sinh (US-8.6, US-9.2 PDF, US-9.4 Mẫu 03, US-9.5 sổ doanh thu).
// Dùng chung một "việc xuất" cho báo cáo, sổ doanh thu và Mẫu 03. Bảng `exports` và job ở task backend `reports`.

const dateTime = z.iso.datetime({ offset: true });

export const exportFormatSchema = z.enum(['xlsx', 'csv', 'pdf']).meta({
  id: 'ExportFormat',
  description:
    '`xlsx`, `csv` (UTF-8 có BOM, mở đúng tiếng Việt trong Excel; tiền là số, ngày dd/mm/yyyy, US-8.6 AC1, AC2), `pdf` (khổ A4: chỉ sổ doanh thu và Mẫu 03)',
});
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const exportTypeSchema = z
  .enum(['revenue', 'payments', 'receivables', 'revenue_book', 'form03'])
  .meta({
    id: 'ExportType',
    description:
      '`revenue` = doanh thu theo lớp và theo tháng (T12); `payments` = các khoản thu (sổ `revenue_ledger`) trong khoảng tháng; `receivables` = công nợ hiện tại (T11); `revenue_book` = sổ doanh thu của một năm (US-9.5); `form03` = báo cáo Mẫu 03 (US-9.4). Client coi giá trị lạ như tệp bình thường',
  });

export const createExportRequestSchema = z
  .object({
    type: z.enum(['revenue', 'payments', 'receivables']).meta({
      description:
        'Loại báo cáo (US-8.6 AC1). Sổ doanh thu xuất bằng `POST /compliance/revenue-book/export`, Mẫu 03 bằng `POST /compliance/form03/pdf`',
    }),
    fromMonth: reportMonthSchema.optional().meta({
      description:
        'Tháng đầu `YYYY-MM` (theo múi giờ tenant). Bắt buộc với `revenue` và `payments`; bị bỏ qua với `receivables` (công nợ hiện tại)',
    }),
    toMonth: reportMonthSchema.optional().meta({
      description:
        'Tháng cuối `YYYY-MM`, không trước `fromMonth`, khoảng tối đa 24 tháng; vi phạm → 422 `VALIDATION_FAILED`',
    }),
    formats: z
      .array(z.enum(['xlsx', 'csv']))
      .min(1)
      .max(2)
      .default(['xlsx', 'csv'])
      .meta({ description: 'Mặc định cả `xlsx` và `csv` (Spec §5.4 M8)' }),
  })
  .meta({
    id: 'CreateExportRequest',
    example: {
      type: 'revenue',
      fromMonth: '2026-09',
      toMonth: '2026-11',
      formats: ['xlsx', 'csv'],
    },
  });
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

export const exportStatusSchema = z
  .enum(['queued', 'processing', 'ready', 'failed'])
  .meta({
    id: 'ExportStatus',
    description:
      '`queued`/`processing` = worker chưa xong, client hỏi lại `GET /exports/{id}` mỗi vài giây; `ready` = có `files`; `failed` = worker lỗi, tạo việc mới. Client coi giá trị lạ như `processing`',
  });

export const exportFileSchema = z
  .object({
    format: exportFormatSchema,
    fileId: z.uuid(),
    sizeBytes: z.int().min(0),
    downloadUrl: z.url().meta({
      description:
        'URL presigned tải ngay, hết hạn ở `expiresAt` (link tải 72 giờ, Spec §2.7); hết hạn thì hỏi lại `GET /exports/{id}` để lấy URL mới trong thời hạn lưu tệp (7 ngày)',
    }),
    expiresAt: dateTime,
  })
  .meta({ id: 'ExportFile' });

export const exportJobSchema = z
  .object({
    id: z.uuid(),
    type: exportTypeSchema,
    status: exportStatusSchema,
    params: z.record(z.string(), z.unknown()).meta({
      description:
        'Tham số đã nhận (`fromMonth`, `toMonth`, `year`, `formats`) để màn hình ghi lại "Xuất doanh thu 09–11/2026"',
    }),
    files: z.array(exportFileSchema).meta({
      description: 'Rỗng tới khi `ready`; mỗi định dạng một tệp',
    }),
    createdAt: dateTime,
    finishedAt: dateTime.nullable(),
  })
  .meta({
    id: 'ExportJob',
    example: {
      id: '019c0d50-0001-7b30-8c01-000000000001',
      type: 'revenue',
      status: 'queued',
      params: {
        fromMonth: '2026-09',
        toMonth: '2026-11',
        formats: ['xlsx', 'csv'],
      },
      files: [],
      createdAt: '2026-12-01T09:00:00+07:00',
      finishedAt: null,
    },
  });
export type ExportJob = z.infer<typeof exportJobSchema>;
