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

  it('tại chỗ chưa có địa điểm vẫn hợp lệ (onboarding nhập sau)', () => {
    expect(classDraftErrors({ ...ok, location: null })).toEqual({});
    expect(classDraftErrors({ ...ok, location: '  ' })).toEqual({});
  });

  it('ngày kết thúc trước ngày bắt đầu', () => {
    expect(
      Object.keys(classDraftErrors({ ...ok, endDate: '2026-12-13' })),
    ).toEqual(['endDate']);
  });
});
