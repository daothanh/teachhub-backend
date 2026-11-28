// Giờ yên lặng toàn tenant (US-6.5): thuần, chỉ dùng `Intl` (không kéo index module schedule vào domain).

/** `YYYY-MM-DDTHH:MM:SS` giờ địa phương của `tz` và độ lệch UTC (ms) tại `at`. */
function localParts(at: Date, tz: string): { iso: string; offset: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const iso = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  return {
    iso,
    offset: Date.parse(`${iso}Z`) - Math.floor(at.getTime() / 1000) * 1000,
  };
}

/** `date` = `YYYY-MM-DD`, `hhmm` = `HH:MM` giờ địa phương của `tz`. Hai vòng vì độ lệch có thể đổi quanh lúc đổi giờ. */
function zonedToInstant(date: string, hhmm: string, tz: string): Date {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const first = guess - localParts(new Date(guess), tz).offset;
  return new Date(guess - localParts(new Date(first), tz).offset);
}

export interface QuietWindow {
  /** `HH:MM` giờ tenant, bao gồm mốc này. */
  start: string;
  /** `HH:MM` giờ tenant, không bao gồm mốc này. Nhỏ hơn `start` = khung qua nửa đêm. */
  end: string;
}

/** Mặc định khi tenant chưa chỉnh (US-6.5 AC1). */
export const DEFAULT_QUIET_WINDOW: QuietWindow = {
  start: '21:30',
  end: '07:00',
};

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutes = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Đọc `tenants.settings.quietHours`; thiếu hoặc sai dạng thì về mặc định. */
export function parseQuietWindow(settings: unknown): QuietWindow {
  const q = (settings as { quietHours?: Partial<QuietWindow> } | null)
    ?.quietHours;
  return q &&
    typeof q.start === 'string' &&
    typeof q.end === 'string' &&
    HHMM.test(q.start) &&
    HHMM.test(q.end) &&
    q.start !== q.end
    ? { start: q.start, end: q.end }
    : DEFAULT_QUIET_WINDOW;
}

/**
 * `now` nằm trong khung (theo giờ `tz`) thì trả mốc `end` kế tiếp, ngoài khung trả `null`.
 * Tính theo phút: `start` thuộc khung, `end` thì không.
 */
export function quietUntil(
  now: Date,
  tz: string,
  window: QuietWindow = DEFAULT_QUIET_WINDOW,
): Date | null {
  const local = localParts(now, tz).iso;
  const m = minutes(local.slice(11, 16));
  const s = minutes(window.start);
  const e = minutes(window.end);
  const crosses = s > e;
  const inside = crosses ? m >= s || m < e : m >= s && m < e;
  if (!inside) return null;
  const date = local.slice(0, 10);
  // Khung qua nửa đêm và đang ở phần trước nửa đêm: mốc kết thúc là sáng hôm sau.
  const endDate =
    crosses && m >= s
      ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : date;
  return zonedToInstant(endDate, window.end, tz);
}
