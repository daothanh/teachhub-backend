import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OFFSETS_DAYS,
  inSendWindow,
  isDunnable,
  parseDunningSettings,
  reminderCopy,
  splitDue,
} from './dunning.js';

describe('parseDunningSettings', () => {
  it('thiếu hoặc hỏng → bật, lịch mặc định d−1, d0, d+3, d+7', () => {
    for (const raw of [
      null,
      {},
      { dunning: 'x' },
      { dunning: { offsetsDays: [] } },
    ])
      expect(parseDunningSettings(raw)).toEqual({
        enabled: true,
        offsetsDays: DEFAULT_OFFSETS_DAYS,
      });
    expect(DEFAULT_OFFSETS_DAYS).toEqual([-1, 0, 3, 7]);
  });

  it('đọc đúng giá trị đã lưu', () => {
    expect(
      parseDunningSettings({
        dunning: { enabled: false, offsetsDays: [0, 5] },
      }),
    ).toEqual({ enabled: false, offsetsDays: [0, 5] });
  });
});

describe('inSendWindow (07:00–21:30)', () => {
  it.each([
    [6 * 60 + 59, false],
    [7 * 60, true],
    [21 * 60 + 30, true],
    [21 * 60 + 31, false],
    [21 * 60 + 45, false],
    [0, false],
  ])('phút %i → %s', (m, ok) => expect(inSendWindow(m)).toBe(ok));
});

describe('isDunnable: nợ thật = tổng − đã thu − đã chuyển kỳ', () => {
  const base = {
    status: 'issued',
    totalAmount: 1_000_000,
    paidAmount: 0,
    carriedAmount: 0,
  };
  it('còn nợ → nhắc', () => {
    expect(isDunnable(base)).toBe(true);
    expect(
      isDunnable({ ...base, status: 'partially_paid', paidAmount: 400_000 }),
    ).toBe(true);
  });
  it('thu đủ, đã chuyển hết nợ sang kỳ sau, hủy, 0 đ, bản nháp → không nhắc', () => {
    expect(isDunnable({ ...base, status: 'paid', paidAmount: 1_000_000 })).toBe(
      false,
    );
    expect(
      isDunnable({
        ...base,
        status: 'partially_paid',
        paidAmount: 300_000,
        carriedAmount: 700_000,
      }),
    ).toBe(false);
    expect(isDunnable({ ...base, status: 'void' })).toBe(false);
    expect(isDunnable({ ...base, totalAmount: 0 })).toBe(false);
    expect(isDunnable({ ...base, status: 'draft' })).toBe(false);
  });
});

describe('splitDue: chỉ gửi mốc muộn nhất của mỗi hóa đơn', () => {
  const at = (id: string, d: string) => ({
    id,
    offsetDays: 0,
    scheduledFor: new Date(d),
  });
  it('một mốc → gửi; nhiều mốc dồn → gửi mốc muộn nhất, bỏ các mốc sớm', () => {
    expect(splitDue([at('a', '2027-01-09T02:00:00Z')])).toMatchObject({
      send: { id: 'a' },
      skip: [],
    });
    const r = splitDue([
      at('c', '2027-01-13T02:00:00Z'),
      at('a', '2027-01-09T02:00:00Z'),
      at('b', '2027-01-10T02:00:00Z'),
    ]);
    expect(r.send?.id).toBe('c');
    expect(r.skip.map((s) => s.id)).toEqual(['a', 'b']);
    expect(splitDue([]).send).toBeNull();
  });
});

describe('reminderCopy: do hệ thống đứng tên, có số còn nợ và hạn', () => {
  it('mốc quá hạn 3 ngày', () => {
    const c = reminderCopy({
      offsetDays: 3,
      remainingAmount: 700_000,
      dueDate: '2027-01-10',
      code: 'TH-25K7Q9',
    });
    expect(c.body).toBe(
      'DayHoc nhắc: hóa đơn TH-25K7Q9 đã quá hạn 3 ngày, hạn 10/01/2027, còn nợ 700.000 đ. Mở ứng dụng DayHoc để xem hóa đơn và chuyển khoản.',
    );
    expect(c.title).toBe('DayHoc nhắc học phí');
  });
  it('trước hạn và đúng hạn', () => {
    const a = { remainingAmount: 1_200_000, dueDate: '2027-01-10' };
    expect(reminderCopy({ ...a, offsetDays: -1 }).body).toContain(
      'sắp đến hạn (còn 1 ngày)',
    );
    expect(reminderCopy({ ...a, offsetDays: 0 }).body).toContain(
      'đến hạn hôm nay',
    );
    expect(reminderCopy({ ...a, offsetDays: 0 }).body).toContain('1.200.000 đ');
  });
});
