import { canSet, toView } from './onboarding.js';

describe('onboarding domain', () => {
  it('chưa lưu gì → 5 bước pending, currentStep = create_class', () => {
    const v = toView(undefined);
    expect(v.steps.map((s) => s.status)).toEqual(Array(5).fill('pending'));
    expect(v.currentStep).toBe('create_class');
  });

  it('currentStep là bước pending đầu tiên, bỏ qua bước done/skipped', () => {
    const v = toView({ create_class: 'done', add_students: 'skipped' });
    expect(v.currentStep).toBe('set_schedule');
  });

  it('bước dở ở giữa (bước 2 pending, bước 3 done) → currentStep = bước 2', () => {
    expect(
      toView({ create_class: 'done', set_schedule: 'done' }).currentStep,
    ).toBe('add_students');
  });

  it('xử lý hết → currentStep null', () => {
    const all = {
      create_class: 'done',
      add_students: 'done',
      set_schedule: 'skipped',
      payout_account: 'skipped',
      compliance_checklist: 'done',
    } as const;
    expect(toView(all).currentStep).toBeNull();
  });

  it('create_class không được skipped', () => {
    expect(canSet('create_class', 'skipped')).toBe(false);
    expect(canSet('create_class', 'done')).toBe(true);
    expect(canSet('add_students', 'skipped')).toBe(true);
  });
});
