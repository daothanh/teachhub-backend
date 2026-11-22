// Hàm thuần cho `files` (Spec §3.3, §3.6c). Không phụ thuộc Nest/Drizzle.

export type FilePurpose = 'receipt';

/** URL PUT/GET sống 10 phút (Spec §3.3). */
export const PRESIGN_TTL_SEC = 600;
/** Tệp `pending` quá ngần này giờ chưa `complete` bị job dọn xóa (Spec §3.6c). */
export const PENDING_TTL_HOURS = 24;

interface PurposePolicy {
  /** Tiền tố khóa đối tượng. */
  prefix: string;
  maxBytes: number;
  /** MIME → đuôi tệp trong khóa (đuôi do server chọn, không lấy từ tên gốc). */
  mimes: Readonly<Record<string, string>>;
}

// Biên lai (US-7.7): ảnh JPEG/PNG/HEIC ≤ 10 MB theo hợp đồng Sprint 8. Mục đích khác thêm ở Sprint 9.
export const PURPOSE_POLICY: Record<FilePurpose, PurposePolicy> = {
  receipt: {
    prefix: 'receipts',
    maxBytes: 10_000_000,
    mimes: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic' },
  },
};

/** `image/JPEG; charset=x` → `image/jpeg`. */
export const normalizeMime = (mime: string): string =>
  (mime.split(';')[0] ?? '').trim().toLowerCase();

/** Đuôi tệp nếu MIME được phép cho `purpose`, ngược lại `null`. */
export const extensionFor = (
  purpose: FilePurpose,
  mime: string,
): string | null => PURPOSE_POLICY[purpose].mimes[normalizeMime(mime)] ?? null;

/** `{tenant_id}/{prefix}/{entity_id}/{uuid}.{ext}`: `random` phải là UUID ngẫu nhiên (v4), không phải v7 chứa giờ. */
export const objectKeyOf = (a: {
  tenantId: string;
  purpose: FilePurpose;
  entityId: string;
  random: string;
  ext: string;
}): string =>
  `${a.tenantId}/${PURPOSE_POLICY[a.purpose].prefix}/${a.entityId}/${a.random}.${a.ext}`;
