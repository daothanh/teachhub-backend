import {
  addDays,
  adjustedUpdatedAt,
  clockSkewMs,
  isAbsenceRetracted,
  isNewAbsence,
  isWithinEditWindow,
  summarize,
  winsLww,
} from './attendance-policy.js';

const at = (s: string) => new Date(s);

describe('cửa sổ sửa 7 ngày theo ngày buổi học', () => {
  it('ngày thứ 7 còn sửa được, sang ngày thứ 8 thì đóng', () => {
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(isWithinEditWindow('2026-12-15', '2026-12-22')).toBe(true);
    expect(isWithinEditWindow('2026-12-15', '2026-12-23')).toBe(false);
  });

  it('buổi tương lai chưa sửa được; đúng ngày buổi học thì mở', () => {
    expect(isWithinEditWindow('2026-12-15', '2026-12-14')).toBe(false);
    expect(isWithinEditWindow('2026-12-15', '2026-12-15')).toBe(true);
  });
});

describe('hiệu chỉnh lệch đồng hồ', () => {
  const server = at('2026-12-15T12:00:00Z');

  it('thiết bị chậm 10 phút: mốc sửa cộng bù đúng 10 phút', () => {
    const device = at('2026-12-15T11:50:00Z');
    expect(clockSkewMs(server, device)).toBe(600_000);
    expect(
      adjustedUpdatedAt(
        at('2026-12-15T11:40:00Z'),
        device,
        server,
      ).toISOString(),
    ).toBe('2026-12-15T11:50:00.000Z');
  });

  it('lệch quá 24 giờ bị kẹp; mốc không vượt giờ nhận', () => {
    const device = at('2026-12-01T12:00:00Z');
    expect(clockSkewMs(server, device)).toBe(86_400_000);
    expect(adjustedUpdatedAt(device, device, server) <= server).toBe(true);
    const fast = at('2026-12-16T12:00:00Z'); // thiết bị nhanh 1 ngày → bù âm
    expect(adjustedUpdatedAt(fast, fast, server).toISOString()).toBe(
      '2026-12-15T12:00:00.000Z',
    );
  });

  it('clientUpdatedAt sau deviceTime (bất khả) bị kẹp về deviceTime', () => {
    const device = at('2026-12-15T11:59:00Z');
    expect(
      adjustedUpdatedAt(
        at('2026-12-15T13:00:00Z'),
        device,
        server,
      ).toISOString(),
    ).toBe('2026-12-15T12:00:00.000Z');
  });
});

describe('mốc LWW cắt về giây', () => {
  const server = at('2026-12-15T12:00:00.900Z');

  it('hai sửa cùng giây (khác mili giây) có mốc bằng nhau nên bản sau ra stale', () => {
    const device = at('2026-12-15T11:59:50.100Z');
    const a = adjustedUpdatedAt(at('2026-12-15T11:59:40.100Z'), device, server);
    const b = adjustedUpdatedAt(at('2026-12-15T11:59:40.150Z'), device, server);
    expect(a.getTime() % 1000).toBe(0);
    expect(winsLww(b, a)).toBe(false);
  });

  it('thiết bị nhanh (lệch âm): mốc lùi đúng độ lệch và không vượt giờ nhận', () => {
    const device = at('2026-12-15T12:10:00Z'); // nhanh 10 phút
    expect(clockSkewMs(server, device)).toBe(-599_100);
    const m = adjustedUpdatedAt(at('2026-12-15T12:09:00Z'), device, server);
    expect(m.toISOString()).toBe('2026-12-15T11:59:00.000Z');
  });
});

describe('LWW', () => {
  it('chỉ thắng khi lớn hơn; bằng nhau → stale', () => {
    expect(
      winsLww(at('2026-12-15T12:00:01Z'), at('2026-12-15T12:00:00Z')),
    ).toBe(true);
    expect(
      winsLww(at('2026-12-15T12:00:00Z'), at('2026-12-15T12:00:00Z')),
    ).toBe(false);
    expect(
      winsLww(at('2026-12-15T11:00:00Z'), at('2026-12-15T12:00:00Z')),
    ).toBe(false);
    expect(winsLww(at('2026-12-15T11:00:00Z'), null)).toBe(true);
  });
});

describe('báo vắng và đính chính', () => {
  it('vắng không phép mới / đính chính', () => {
    expect(isNewAbsence(null, 'unexcused')).toBe(true);
    expect(isNewAbsence('present', 'unexcused')).toBe(true);
    expect(isNewAbsence('unexcused', 'unexcused')).toBe(false);
    expect(isNewAbsence('present', 'excused')).toBe(false);
    // US-3.2 AC2: vắng có phép (kể cả do phụ huynh đã báo trước) không phải "vắng mới" nên không báo lại.
    expect(isNewAbsence(null, 'excused')).toBe(false);
    expect(isAbsenceRetracted('unexcused', 'present')).toBe(true);
    expect(isAbsenceRetracted('unexcused', 'late')).toBe(true);
    expect(isAbsenceRetracted('unexcused', 'excused')).toBe(false);
    expect(isAbsenceRetracted('excused', 'present')).toBe(false);
  });

  it('summarize đếm theo trạng thái', () => {
    expect(summarize(['present', 'present', 'late', 'unexcused'])).toEqual({
      present: 2,
      late: 1,
      excused: 0,
      unexcused: 1,
    });
  });
});
