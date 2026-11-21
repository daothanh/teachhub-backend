import { summarizeWeek, weekRange } from './week.js';

describe('tuần chuyên cần', () => {
  it.each([
    ['2026-12-14', '2026-12-14', '2026-12-20'], // Thứ Hai
    ['2026-12-15', '2026-12-14', '2026-12-20'],
    ['2026-12-20', '2026-12-14', '2026-12-20'], // Chủ Nhật thuộc tuần trước nó
    ['2026-12-21', '2026-12-21', '2026-12-27'],
    ['2027-01-01', '2026-12-28', '2027-01-03'], // qua năm
  ])('%s → %s..%s', (d, start, end) => {
    expect(weekRange(d)).toEqual({ start, end });
  });

  it('notRecorded chỉ tính buổi đã qua giờ kết thúc; buổi hủy không đếm', () => {
    const now = new Date('2026-12-15T12:00:00Z');
    const at = (h: number) => new Date(`2026-12-15T${h}:00:00Z`);
    expect(
      summarizeWeek(
        [
          {
            endsAt: at(10),
            sessionStatus: 'taught',
            attendanceStatus: 'present',
          },
          { endsAt: at(11), sessionStatus: 'taught', attendanceStatus: null }, // đã qua, chưa điểm danh
          { endsAt: at(12), sessionStatus: 'planned', attendanceStatus: null }, // đúng giờ kết thúc = đã qua
          { endsAt: at(13), sessionStatus: 'planned', attendanceStatus: null }, // chưa qua
          { endsAt: at(9), sessionStatus: 'cancelled', attendanceStatus: null },
          {
            endsAt: at(8),
            sessionStatus: 'taught',
            attendanceStatus: 'unexcused',
          },
        ],
        now,
      ),
    ).toEqual({
      present: 1,
      late: 0,
      excused: 0,
      unexcused: 1,
      notRecorded: 2,
      upcoming: 1,
    });
  });
});
