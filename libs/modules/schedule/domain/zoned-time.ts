// Đổi giờ địa phương ↔ thời điểm tuyệt đối theo múi giờ IANA, chỉ dùng `Intl` của Node (không thư viện).

const PARTS = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
} as const;

/** Độ lệch UTC (ms) của `tz` tại thời điểm `at`. */
function offsetMs(at: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, ...PARTS })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(
    p.year!,
    p.month! - 1,
    p.day!,
    p.hour!,
    p.minute!,
    p.second!,
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** `date` = `YYYY-MM-DD`, `time` = `HH:mm` theo giờ địa phương của `tz`. Giờ không tồn tại/lặp (DST) lấy lần đầu. */
export function zonedToInstant(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  // Hai vòng: độ lệch tại điểm đoán có thể khác độ lệch tại điểm đúng quanh lúc đổi giờ.
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}

/** ISO 8601 kèm độ lệch, vd. `2026-12-15T18:00:00+07:00`. */
export function formatInZone(at: Date, tz: string): string {
  const off = offsetMs(at, tz);
  const local = new Date(Math.floor(at.getTime() / 1000) * 1000 + off);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off) / 60_000;
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/** Ngày `YYYY-MM-DD` của `at` theo `tz`. */
export function localDate(at: Date, tz: string): string {
  return formatInZone(at, tz).slice(0, 10);
}
