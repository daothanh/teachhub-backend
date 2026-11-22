import { buildChecklist, type StoredItem } from './checklist.js';

const done = (extra: Partial<StoredItem> = {}): StoredItem => ({
  status: 'done',
  data: null,
  completedAt: '2026-12-01T09:00:00+07:00',
  ...extra,
});

describe('buildChecklist', () => {
  it('tenant mới: đủ bốn mục todo, 0%, bước tiếp theo là mục đầu', () => {
    const c = buildChecklist(new Map(), new Set());
    expect(c.items.map((i) => i.status)).toEqual([
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(c).toMatchObject({
      totalCount: 4,
      completedCount: 0,
      percent: 0,
      nextItemKey: 'business_registration',
    });
    expect(c.items.map((i) => i.auto)).toEqual([false, false, true, true]);
    expect(c.items.every((i) => i.legalArticleSlug === null)).toBe(true);
  });

  it('% làm tròn xuống; bước tiếp theo bỏ qua mục đã xong', () => {
    const c = buildChecklist(
      new Map([
        ['business_registration', done()],
        ['registration_number', done({ data: { registrationNo: '01A' } })],
        ['public_disclosure', done()],
      ]),
      new Set(),
    );
    expect(c).toMatchObject({
      completedCount: 3,
      totalCount: 4,
      percent: 75,
      nextItemKey: 'school_declaration',
    });
  });

  it('not_applicable không tính vào tổng và % (1/3 = 33)', () => {
    const c = buildChecklist(
      new Map<string, StoredItem>([
        ['business_registration', done()],
        [
          'school_declaration',
          { status: 'not_applicable', data: null, completedAt: null },
        ],
      ]),
      new Set(),
    );
    expect(c).toMatchObject({ totalCount: 3, completedCount: 1, percent: 33 });
  });

  it('xong hết: nextItemKey null, 100%', () => {
    const all = new Map(
      [
        'business_registration',
        'registration_number',
        'public_disclosure',
        'school_declaration',
      ].map((k) => [k, done()] as const),
    );
    expect(buildChecklist(all, new Set())).toMatchObject({
      percent: 100,
      nextItemKey: null,
    });
  });

  it('chỉ trả slug bài đã phát hành', () => {
    const c = buildChecklist(new Map(), new Set(['dang-ky-ho-kinh-doanh']));
    expect(c.items.map((i) => i.legalArticleSlug)).toEqual([
      'dang-ky-ho-kinh-doanh',
      'dang-ky-ho-kinh-doanh',
      null,
      null,
    ]);
  });
});
