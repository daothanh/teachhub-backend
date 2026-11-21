// Tuần Thứ Hai–Chủ Nhật và tóm tắt chuyên cần cho phụ huynh (US-0.3 AC4). Hàm thuần.

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Tuần (Thứ Hai → Chủ Nhật) chứa ngày `anchor` (`YYYY-MM-DD`, ngày theo múi giờ tenant). */
export function weekRange(anchor: string): { start: string; end: string } {
  const ms = Date.parse(`${anchor}T00:00:00Z`);
  const mondayOffset = (new Date(ms).getUTCDay() + 6) % 7; // 0 = Thứ Hai
  const start = ms - mondayOffset * DAY_MS;
  return { start: iso(start), end: iso(start + 6 * DAY_MS) };
}

export interface WeekSession {
  endsAt: Date;
  sessionStatus: string;
  attendanceStatus: string | null;
}

export interface WeekSummary {
  present: number;
  late: number;
  excused: number;
  unexcused: number;
  notRecorded: number;
  upcoming: number;
}

/**
 * Đếm theo buổi KHÔNG hủy. Có điểm danh → đếm theo trạng thái; chưa có thì `notRecorded` chỉ khi buổi đã qua giờ
 * kết thúc, còn lại `upcoming`.
 */
export function summarizeWeek(sessions: WeekSession[], now: Date): WeekSummary {
  const s: WeekSummary = {
    present: 0,
    late: 0,
    excused: 0,
    unexcused: 0,
    notRecorded: 0,
    upcoming: 0,
  };
  for (const x of sessions) {
    if (x.sessionStatus === 'cancelled') continue;
    if (x.attendanceStatus && x.attendanceStatus in s) {
      s[x.attendanceStatus as 'present' | 'late' | 'excused' | 'unexcused']++;
    } else if (x.endsAt <= now) s.notRecorded++;
    else s.upcoming++;
  }
  return s;
}
