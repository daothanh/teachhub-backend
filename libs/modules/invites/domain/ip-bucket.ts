import { isIPv4, isIPv6 } from 'node:net';

/** Mở rộng IPv6 về 8 nhóm 16-bit (không xử lý zone id). */
function groups(ip: string): number[] {
  const [head = '', tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::')
    ? Array(8 - h.length - t.length).fill('0')
    : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}

/**
 * Khóa đếm theo IP: IPv4 giữ nguyên, IPv6 gộp theo /64 (một thuê bao có cả dải /64 nên đếm từng địa chỉ là vô nghĩa),
 * `::ffff:a.b.c.d` về IPv4. IP không hợp lệ → 'unknown' (vẫn bị đếm chung, không bỏ qua giới hạn).
 */
export function ipBucket(ip: string | undefined): string {
  const raw = (ip ?? '').split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(raw)) return raw;
  if (isIPv6(raw)) {
    return `${groups(raw)
      .slice(0, 4)
      .map((g) => g.toString(16))
      .join(':')}::/64`;
  }
  return 'unknown';
}
