// Hàm thuần cho phát hành hóa đơn (S5-BE-07, US-7.3). Không phụ thuộc Nest/Drizzle.
import { randomInt } from 'node:crypto';

/** Tên sự kiện outbox khi một hóa đơn được phát hành. */
export const INVOICE_ISSUED = 'invoice_issued';

/** Payload outbox `invoice_issued`: không tên học viên, không tài khoản nhận tiền (consumer tự tra tên). */
export interface InvoiceIssuedPayload {
  invoiceId: string;
  studentId: string;
  periodMonth: string;
  totalAmount: number;
  dueDate: string;
}

// Crockford base32 (bỏ I, L, O, U): khớp CHECK `invoices_code_check` của migration 0024, không nhầm 0/O, 1/I khi gõ tay.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Mã hóa đơn `TH-XXXXXX` (6 ký tự, ~1 tỷ khả năng); duy nhất trong tenant: service kiểm trùng dưới khóa advisory theo tenant, ràng buộc `invoices_tenant_code_uq` là lớp cuối. */
export const generateInvoiceCode = (
  pick: (max: number) => number = randomInt,
): string =>
  `TH-${Array.from({ length: 6 }, () => ALPHABET[pick(ALPHABET.length)]).join('')}`;

/** Nội dung chuyển khoản `TH XXXXXX` (9 ký tự, ASCII hoa, không dấu, ≤ 25 ký tự của VietQR). */
export const transferNoteOf = (code: string): string => code.replace('-', ' ');
