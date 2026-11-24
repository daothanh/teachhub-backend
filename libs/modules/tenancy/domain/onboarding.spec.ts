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

  it('toView trả đủ 5 bước theo đúng thứ tự US-0.2', () => {
    expect(toView(undefined).steps.map((s) => s.step)).toEqual([
      'create_class',
      'add_students',
      'set_schedule',
      'payout_account',
      'compliance_checklist',
    ]);
  });

  it('canSet: chỉ create_class cấm skipped, mọi bước còn lại cho phép skipped và done', () => {
    for (const step of [
      'add_students',
      'set_schedule',
      'payout_account',
      'compliance_checklist',
    ] as const) {
      expect(canSet(step, 'skipped')).toBe(true);
      expect(canSet(step, 'done')).toBe(true);
    }
    expect(canSet('create_class', 'done')).toBe(true);
    expect(canSet('create_class', 'skipped')).toBe(false);
  });

  it('chỉ bước cuối còn pending → currentStep là bước cuối', () => {
    const v = toView({
      create_class: 'done',
      add_students: 'done',
      set_schedule: 'done',
      payout_account: 'done',
    });
    expect(v.currentStep).toBe('compliance_checklist');
    expect(v.steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'pending',
    ]);
  });

  it('bỏ qua hết các bước được phép (create_class done, 4 bước sau skipped) → currentStep null', () => {
    const v = toView({
      create_class: 'done',
      add_students: 'skipped',
      set_schedule: 'skipped',
      payout_account: 'skipped',
      compliance_checklist: 'skipped',
    });
    expect(v.currentStep).toBeNull();
  });
});
