import { planGuardianSync } from './guardian-sync.js';

describe('planGuardianSync', () => {
  it('có id → cập nhật, không id → tạo mới, vắng → gỡ', () => {
    const plan = planGuardianSync(['a', 'b'], [{ id: 'a', n: 1 }, { n: 2 }]);
    expect(plan.errors).toEqual({});
    expect(plan.toUpdate).toEqual([{ id: 'a', n: 1 }]);
    expect(plan.toCreate).toEqual([{ n: 2 }]);
    expect(plan.toRemove).toEqual(['b']);
  });

  it('danh sách rỗng gỡ hết; id không thuộc học viên → lỗi đúng chỉ số, không phân biệt lý do', () => {
    expect(planGuardianSync(['a'], []).toRemove).toEqual(['a']);
    const plan = planGuardianSync(['a'], [{ id: 'a' }, { id: 'x' }]);
    expect(Object.keys(plan.errors)).toEqual(['guardians.1.id']);
  });

  it('cùng id hai lần → lỗi ở lần lặp; học viên mới (không có phụ huynh) nhận id → lỗi', () => {
    const dup = planGuardianSync(['a'], [{ id: 'a' }, { id: 'a' }]);
    expect(Object.keys(dup.errors)).toEqual(['guardians.1.id']);
    expect(Object.keys(planGuardianSync([], [{ id: 'a' }]).errors)).toEqual([
      'guardians.0.id',
    ]);
  });
});
