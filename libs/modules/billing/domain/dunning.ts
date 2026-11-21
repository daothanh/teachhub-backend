// Hàm thuần cho nhắc nợ (S6-BE-04, US-7.5). Không phụ thuộc Nest/Drizzle. Tiền là số nguyên đồng.
import { formatVnd } from './carry-over.js';
import { remainingOf } from './payment.js';

/** Tên sự kiện outbox khi job `billing.dunning` gửi một lời nhắc. */
export const PAYMENT_REMINDER = 'payment_reminder';

/** Payload outbox `payment_reminder`: không tên học viên (consumer tự tra tên). */
export interface PaymentReminderPayload {
  invoiceId: string;
  studentId: string;
  offsetDays: number;
  remainingAmount: number;
  dueDate: string;
}

/** Lịch mặc định US-7.5 AC1: ngày 9, 10, 13, 17 cho hóa đơn hạn ngày 10. */
export const DEFAULT_OFFSETS_DAYS = [-1, 0, 3, 7];

/** Giờ gửi của mỗi mốc (giờ tenant) và khung giờ job được phép gửi, tính theo phút trong ngày (Spec §6.7: 07:00–21:30). */
export const SEND_TIME = '09:00';
export const WINDOW_START_MIN = 7 * 60;
export const WINDOW_END_MIN = 21 * 60 + 30;

export interface DunningSettings {
  enabled: boolean;
  offsetsDays: number[];
}

/** Cài đặt nhắc nợ nằm ở `tenants.settings.dunning`; thiếu hoặc hỏng → mặc định (bật, lịch mặc định). */
export function parseDunningSettings(settings: unknown): DunningSettings {
  const raw = (
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).dunning
      : undefined
  ) as Partial<DunningSettings> | undefined;
  const offsets = raw?.offsetsDays;
  const ok =
    Array.isArray(offsets) &&
    offsets.length >= 1 &&
    offsets.every((n) => Number.isInteger(n));
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : true,
    offsetsDays: ok ? (offsets as number[]) : [...DEFAULT_OFFSETS_DAYS],
  };
}

/** `now` (phút trong ngày theo giờ tenant) có trong khung 07:00–21:30 không. */
export const inSendWindow = (minuteOfDay: number): boolean =>
  minuteOfDay >= WINDOW_START_MIN && minuteOfDay <= WINDOW_END_MIN;

/**
 * Số phút phải chờ từ `minuteOfDay` (giờ tenant) tới khi vào khung gửi: 0 trong khung 07:00–21:30, trước 07:00 chờ tới 07:00 cùng
 * ngày, sau 21:30 chờ tới 07:00 hôm sau. shortcut: bỏ qua ngày đổi giờ (múi giờ VN không có).
 */
export const minutesUntilSendWindow = (minuteOfDay: number): number =>
  inSendWindow(minuteOfDay)
    ? 0
    : minuteOfDay < WINDOW_START_MIN
      ? WINDOW_START_MIN - minuteOfDay
      : 24 * 60 - minuteOfDay + WINDOW_START_MIN;

/** Hóa đơn còn đáng nhắc: đã phát hành, chưa thu đủ và còn nợ thật (`total − paid − carried > 0`). */
export const isDunnable = (inv: {
  status: string;
  totalAmount: number;
  paidAmount: number;
  carriedAmount: number;
}): boolean =>
  (inv.status === 'issued' || inv.status === 'partially_paid') &&
  remainingOf(inv.totalAmount, inv.paidAmount, inv.carriedAmount) > 0;

/** Tên mốc cho người đọc: "trước hạn 1 ngày", "đúng hạn", "quá hạn 3 ngày". */
export const offsetPhrase = (offsetDays: number): string =>
  offsetDays < 0
    ? `sắp đến hạn (còn ${-offsetDays} ngày)`
    : offsetDays === 0
      ? 'đến hạn hôm nay'
      : `đã quá hạn ${offsetDays} ngày`;

const dmy = (iso: string) =>
  `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Tin nhắc do hệ thống đứng tên ("DayHoc nhắc…", US-7.5 AC4): có số còn nợ và hạn. Dùng cho email và xem trước; push dùng
 * chữ chung theo loại (không số tiền). `subject` không chứa số tiền hay tên con.
 */
export function reminderCopy(a: {
  offsetDays: number;
  remainingAmount: number;
  dueDate: string;
  code?: string | null;
}): { title: string; body: string } {
  const inv = a.code ? `hóa đơn ${a.code}` : 'hóa đơn học phí';
  return {
    title: 'DayHoc nhắc học phí',
    body: `DayHoc nhắc: ${inv} ${offsetPhrase(a.offsetDays)}, hạn ${dmy(a.dueDate)}, còn nợ ${formatVnd(a.remainingAmount)} đ. Mở ứng dụng DayHoc để xem hóa đơn và chuyển khoản.`,
  };
}

export interface DueStep {
  id: string;
  offsetDays: number;
  scheduledFor: Date;
}

/**
 * Các mốc đến hạn gửi của MỘT hóa đơn (đã `scheduledFor ≤ now`, theo thứ tự thời gian): chỉ gửi mốc muộn nhất, các mốc sớm hơn
 * bị bỏ qua (job nghỉ lâu hoặc khung giờ dồn lại không được dội nhiều tin cùng lúc).
 */
export function splitDue(due: DueStep[]): {
  send: DueStep | null;
  skip: DueStep[];
} {
  const sorted = [...due].sort(
    (a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime(),
  );
  const send = sorted.pop() ?? null;
  return { send, skip: sorted };
}
