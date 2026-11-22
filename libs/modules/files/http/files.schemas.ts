import { z } from 'zod';

// Hợp đồng Sprint 8 (S7-CT-01): tệp qua presigned URL kho S3 (Spec §3.6c, §2.7, §5.4 M4). Tệp không đi qua API.
// Bảng `files` (Spec §4.4) và thân hàm ở task backend `files`.

const dateTime = z.iso.datetime({ offset: true });

export const filePurposeSchema = z.enum(['receipt']).meta({
  id: 'FilePurpose',
  description:
    'Mục đích tệp, quyết định bucket, tiền tố khóa, MIME, kích thước tối đa và ai được tải lên/xuống. Sprint 8 chỉ có `receipt` (biên lai chuyển khoản, US-7.7: ảnh `image/jpeg`, `image/png`, `image/heic`, ≤ 10 MB, bucket private, `entityId` = id hóa đơn). Các mục đích `assignment`, `submission`, `class_message`, `avatar`, `import` thêm vào enum ở Sprint 9 cùng module tương ứng (thêm giá trị vào request không phá hợp đồng). Client coi giá trị lạ ở phản hồi như tệp bình thường',
});

export const uploadUrlRequestSchema = z
  .object({
    purpose: filePurposeSchema,
    entityId: z.uuid().meta({
      description:
        'Thực thể mà tệp sẽ gắn vào, theo `purpose` (`receipt` → id hóa đơn của một con của phụ huynh). Server kiểm quyền với thực thể trước khi cấp URL; không thấy hoặc không có quyền → 404 `NOT_FOUND`',
    }),
    fileName: z.string().trim().min(1).max(255).meta({
      description:
        'Tên gốc chỉ lưu ở bảng `files`, không đưa vào khóa đối tượng (khóa: `{tenant_id}/{prefix}/{entity_id}/{uuid}.{ext}`)',
      example: 'bien-lai.jpg',
    }),
    mimeType: z.string().trim().min(1).max(100).meta({ example: 'image/jpeg' }),
    sizeBytes: z.int().min(1).max(20_000_000).meta({
      description:
        'Kích thước tệp tính bằng byte, trần chung 20 MB; trần theo `purpose` thấp hơn (`receipt` 10 MB)',
      example: 412880,
    }),
  })
  .meta({
    id: 'UploadUrlRequest',
    example: {
      purpose: 'receipt',
      entityId: '019c0a10-0001-7b30-8c01-000000000001',
      fileName: 'bien-lai.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 412880,
    },
  });
export type UploadUrlRequest = z.infer<typeof uploadUrlRequestSchema>;

export const uploadUrlSchema = z
  .object({
    fileId: z.uuid().meta({
      description:
        'Bản ghi `files` ở trạng thái `pending` (quá 24 giờ chưa `complete` bị job dọn xóa)',
    }),
    uploadUrl: z.url().meta({
      description:
        'URL presigned (SigV4) để client PUT trực tiếp lên kho S3; hết hạn sau 10 phút (`expiresAt`)',
    }),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()).meta({
      description:
        'Header client phải gửi nguyên văn cùng PUT (ít nhất `Content-Type` = `mimeType` đã khai); khác đi kho S3 từ chối chữ ký',
      example: { 'Content-Type': 'image/jpeg' },
    }),
    expiresAt: dateTime,
  })
  .meta({
    id: 'UploadUrl',
    example: {
      fileId: '019c0b30-0001-7b30-8c01-000000000001',
      uploadUrl:
        'https://files.example.invalid/teachhub-private/t/receipts/i/f.jpg?X-Amz-Signature=...',
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      expiresAt: '2027-01-05T09:22:00+07:00',
    },
  });
export type UploadUrl = z.infer<typeof uploadUrlSchema>;

export const fileStatusSchema = z.enum(['pending', 'ready']).meta({
  id: 'FileStatus',
  description:
    '`pending` = đã cấp URL, chưa xác nhận; `ready` = server đã HEAD kho S3 và kích thước, content-type khớp. Chỉ tệp `ready` mới gắn được vào bài nộp/biên lai',
});

export const fileRecordSchema = z
  .object({
    id: z.uuid(),
    purpose: filePurposeSchema,
    entityId: z.uuid(),
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.int().min(0),
    status: fileStatusSchema,
    createdAt: dateTime,
  })
  .meta({
    id: 'FileRecord',
    example: {
      id: '019c0b30-0001-7b30-8c01-000000000001',
      purpose: 'receipt',
      entityId: '019c0a10-0001-7b30-8c01-000000000001',
      fileName: 'bien-lai.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 412880,
      status: 'ready',
      createdAt: '2027-01-05T09:12:00+07:00',
    },
  });
export type FileRecord = z.infer<typeof fileRecordSchema>;

export const downloadUrlSchema = z
  .object({
    url: z.url().meta({
      description:
        'URL presigned GET, hết hạn sau 10 phút (`expiresAt`); lấy lại khi hết hạn, đừng lưu lâu',
    }),
    expiresAt: dateTime,
  })
  .meta({
    id: 'FileDownloadUrl',
    example: {
      url: 'https://files.example.invalid/teachhub-private/t/receipts/i/f.jpg?X-Amz-Signature=...',
      expiresAt: '2027-01-05T09:22:00+07:00',
    },
  });
export type FileDownloadUrl = z.infer<typeof downloadUrlSchema>;
