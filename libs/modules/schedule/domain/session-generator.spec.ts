import { generateSessions, MAX_HORIZON_DAYS } from './session-generator.js';
import { formatInZone, localDate, zonedToInstant } from './zoned-time.js';

const TZ = 'Asia/Ho_Chi_Minh';
const T3 = { id: 'r-t3', weekday: 2, startTime: '18:00', durationMin: 90 };
const T5 = { id: 'r-t5', weekday: 4, startTime: '18:00', durationMin: 90 };
const dates = (s: { sessionDate: string }[]) => s.map((x) => x.sessionDate);

describe('SessionGenerator', () => {
  it('T3 + T5 18:00 90 phút, qua ranh giới tháng và năm; giờ lưu theo UTC (UTC+7)', () => {
    const out = generateSessions([T5, T3], {
      classStart: '2026-12-14',
      classEnd: '2027-01-07',
      today: '2026-12-01',
      tz: TZ,
    });
    expect(dates(out)).toEqual([
      '2026-12-15',
      '2026-12-17',
      '2026-12-22',
      '2026-12-24',
      '2026-12-29',
      '2026-12-31',
      '2027-01-05',
      '2027-01-07',
    ]);
    expect(out[0]!.startsAt.toISOString()).toBe('2026-12-15T11:00:00.000Z');
    expect(out[0]!.endsAt.toISOString()).toBe('2026-12-15T12:30:00.000Z');
    expect(formatInZone(out[7]!.startsAt, TZ)).toBe(
      '2027-01-07T18:00:00+07:00',
    );
    expect(out.map((s) => s.ruleId).slice(0, 2)).toEqual(['r-t3', 'r-t5']);
  });

  it('lớp không có ngày kết thúc: cuốn chiếu 8 tuần kể từ ngày bắt đầu (16 buổi cho T3 + T5)', () => {
    const out = generateSessions([T3, T5], {
      classStart: '2026-12-14',
      classEnd: null,
      today: '2026-12-14',
      tz: TZ,
    });
    expect(out).toHaveLength(16);
    expect(out[15]!.sessionDate).toBe('2027-02-04');
  });

  it('lớp đã bắt đầu: chỉ sinh từ hôm nay; lớp bắt đầu tương lai: từ ngày bắt đầu; đã kết thúc: rỗng', () => {
    const base = { classEnd: null, tz: TZ };
    const running = generateSessions([T3], {
      ...base,
      classStart: '2026-01-05',
      today: '2026-12-16',
    });
    expect(running[0]!.sessionDate).toBe('2026-12-22');
    expect(running).toHaveLength(8);
    const future = generateSessions([T3], {
      ...base,
      classStart: '2027-03-01',
      today: '2026-12-16',
    });
    expect(future[0]!.sessionDate).toBe('2027-03-02');
    expect(
      generateSessions([T3], {
        classStart: '2026-01-05',
        classEnd: '2026-06-30',
        today: '2026-12-16',
        tz: TZ,
      }),
    ).toEqual([]);
  });

  it('không có quy tắc → rỗng; ngày bắt đầu và kết thúc cùng một ngày đúng thứ → một buổi', () => {
    const o = {
      classStart: '2026-12-15',
      classEnd: null,
      today: '2026-12-15',
      tz: TZ,
    };
    expect(generateSessions([], o)).toEqual([]);
    expect(
      generateSessions([T3], { ...o, classEnd: '2026-12-15' }),
    ).toHaveLength(1);
  });

  it('ngày kết thúc quá xa bị chặn ở mốc 2 năm', () => {
    const out = generateSessions([T3], {
      classStart: '2026-12-14',
      classEnd: '9999-12-31',
      today: '2026-12-14',
      tz: TZ,
    });
    const last = Date.parse(`${out.at(-1)!.sessionDate}T00:00:00Z`);
    expect(
      (last - Date.parse('2026-12-14T00:00:00Z')) / 86_400_000,
    ).toBeLessThan(MAX_HORIZON_DAYS);
    expect(out.length).toBeGreaterThan(100);
  });

  it('buổi kết thúc đúng 24:00 qua nửa đêm giờ địa phương', () => {
    const [s] = generateSessions(
      [{ id: 'r', weekday: 2, startTime: '23:00', durationMin: 60 }],
      {
        classStart: '2026-12-15',
        classEnd: '2026-12-15',
        today: '2026-12-15',
        tz: TZ,
      },
    );
    expect(formatInZone(s!.endsAt, TZ)).toBe('2026-12-16T00:00:00+07:00');
    expect(s!.sessionDate).toBe('2026-12-15');
  });
});

describe('zoned-time', () => {
  it('múi giờ có DST: giờ địa phương cố định, UTC đổi theo mùa', () => {
    expect(
      zonedToInstant('2026-01-15', '18:00', 'America/New_York').toISOString(),
    ).toBe('2026-01-15T23:00:00.000Z');
    expect(
      zonedToInstant('2026-07-15', '18:00', 'America/New_York').toISOString(),
    ).toBe('2026-07-15T22:00:00.000Z');
  });

  it('localDate theo múi giờ tenant, không theo UTC', () => {
    const at = new Date('2026-12-14T18:30:00Z'); // 01:30 ngày 15 giờ Việt Nam
    expect(localDate(at, TZ)).toBe('2026-12-15');
    expect(localDate(at, 'UTC')).toBe('2026-12-14');
  });
});
