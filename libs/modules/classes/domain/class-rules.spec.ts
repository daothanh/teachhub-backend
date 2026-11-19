import { classDraftErrors } from './class-rules.js';

const ok = {
  mode: 'offline',
  location: 'Nhà',
  startDate: '2026-12-14',
  endDate: null,
} as const;

describe('classDraftErrors', () => {
  it('hợp lệ → rỗng', () => {
    expect(classDraftErrors(ok)).toEqual({});
    expect(classDraftErrors({ ...ok, endDate: '2026-12-14' })).toEqual({});
    expect(classDraftErrors({ ...ok, mode: 'online', location: null })).toEqual(
      {},
    );
  });

  it('tại chỗ thiếu địa điểm (kể cả toàn khoảng trắng)', () => {
    expect(Object.keys(classDraftErrors({ ...ok, location: null }))).toEqual([
      'location',
    ]);
    expect(Object.keys(classDraftErrors({ ...ok, location: '  ' }))).toEqual([
      'location',
    ]);
  });

  it('ngày kết thúc trước ngày bắt đầu', () => {
    expect(
      Object.keys(classDraftErrors({ ...ok, endDate: '2026-12-13' })),
    ).toEqual(['endDate']);
  });
});
