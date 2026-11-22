// Hàm thuần cho `files` (Spec §3.3, §3.6c). Không phụ thuộc Nest/Drizzle.

export type FilePurpose = 'receipt';

/** URL GET sống 10 phút (Spec §3.3). */
export const PRESIGN_TTL_SEC = 600;
/** URL PUT chỉ 2 phút: hẹp cửa sổ ghi đè đối tượng sau khi xin URL (review bảo mật S8). */
export const PUT_TTL_SEC = 120;
/** Số tệp `pending` tối đa mỗi cặp (người tải lên, thực thể): chặn xin URL hàng loạt. */
export const MAX_PENDING_PER_ENTITY = 5;
/** Số byte đầu cần đọc để kiểm magic bytes. */
export const MAGIC_BYTES = 32;
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

const HEIF_BRANDS = [
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
];
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.slice(from, to));

/** Vài byte đầu có đúng chữ ký của MIME đã khai không (JPEG, PNG, HEIC/HEIF). */
export const matchesMagic = (mime: string, b: Uint8Array): boolean => {
  switch (normalizeMime(mime)) {
    case 'image/jpeg':
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return (
        b.length >= 8 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
          (x, i) => b[i] === x,
        )
      );
    case 'image/heic':
      return (
        b.length >= 12 &&
        ascii(b, 4, 8) === 'ftyp' &&
        HEIF_BRANDS.includes(ascii(b, 8, 12))
      );
    default:
      return false;
  }
};
