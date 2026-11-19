import { zonedToInstant } from './zoned-time.js';

// Sinh buổi học từ quy tắc lặp (US-2.1). Hàm thuần: không đọc đồng hồ, không biết CSDL; `today` do người gọi truyền.

export interface RuleInput {
  id: string;
  /** ISO 8601: 1 = Thứ Hai … 7 = Chủ Nhật. */
  weekday: number;
  /** `HH:mm` theo múi giờ của tenant. */
  startTime: string;
  durationMin: number;
}

export interface GeneratedSession {
  ruleId: string;
  /** Ngày học `YYYY-MM-DD` theo múi giờ tenant. */
  sessionDate: string;
  startsAt: Date;
  endsAt: Date;
}

export interface GenerateOptions {
  classStart: string;
  /** null = lớp không kỳ hạn → cuốn chiếu `ROLLING_WEEKS` tuần kể từ ngày bắt đầu sinh. */
  classEnd: string | null;
  /** Hôm nay theo múi giờ tenant: không sinh buổi trước ngày này. */
  today: string;
  tz: string;
}

export const ROLLING_WEEKS = 8;
/**
 * shortcut: lớp có ngày kết thúc quá xa chỉ được sinh tới mốc này (2 năm) để một request không tạo hàng triệu dòng;
 * job nối dài hằng đêm (S2-BE-09) hoặc PUT lại sẽ sinh tiếp.
 */
export const MAX_HORIZON_DAYS = 731;

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isoWeekday = (ms: number) => new Date(ms).getUTCDay() || 7;

/** Khoảng ngày `[from, to]` sẽ có buổi, hoặc null khi lớp đã kết thúc trước hôm nay. */
export function generationWindow(o: GenerateOptions) {
  const from = Math.max(toMs(o.classStart), toMs(o.today));
  const rolling = from + (ROLLING_WEEKS * 7 - 1) * DAY;
  const cap = from + (MAX_HORIZON_DAYS - 1) * DAY;
  const to = o.classEnd ? Math.min(toMs(o.classEnd), cap) : rolling;
  return to < from ? null : { from: toDate(from), to: toDate(to) };
}

/** Buổi theo thứ tự ngày rồi giờ bắt đầu. */
export function generateSessions(
  rules: RuleInput[],
  o: GenerateOptions,
): GeneratedSession[] {
  const win = generationWindow(o);
  if (!win) return [];
  const out: GeneratedSession[] = [];
  for (let d = toMs(win.from); d <= toMs(win.to); d += DAY) {
    const date = toDate(d);
    for (const r of rules) {
      if (r.weekday !== isoWeekday(d)) continue;
      const startsAt = zonedToInstant(date, r.startTime, o.tz);
      out.push({
        ruleId: r.id,
        sessionDate: date,
        startsAt,
        endsAt: new Date(startsAt.getTime() + r.durationMin * 60_000),
      });
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
