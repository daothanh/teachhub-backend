import { classFeeErrors, resolveFeeRules } from './class-fee.js';

const base = {
  feeType: 'per_session',
  feeAmount: 150000,
  feeRules: null,
  endDate: null,
  scheduleRuleCount: 0,
} as const;

describe('resolveFeeRules', () => {
  it('không có học phí → null', () => {
    expect(resolveFeeRules(null, { chargeExcused: false })).toBeNull();
  });

  it('điền mặc định: vắng có phép và không phép đều tính', () => {
    expect(resolveFeeRules('per_session', null)).toEqual({
      chargeExcused: true,
      chargeUnexcused: true,
      deductCancelled: false,
      installments: 1,
    });
  });

  it('tắt được từng công tắc, trường thiếu giữ mặc định', () => {
    expect(
      resolveFeeRules('per_session', { chargeExcused: false }),
    ).toMatchObject({ chargeExcused: false, chargeUnexcused: true });
    expect(
      resolveFeeRules('per_session', { chargeUnexcused: false }),
    ).toMatchObject({ chargeExcused: true, chargeUnexcused: false });
  });

  it('chỉ trọn khóa giữ số đợt', () => {
    expect(resolveFeeRules('course', { installments: 3 })!.installments).toBe(
      3,
    );
    expect(resolveFeeRules('monthly', { installments: 3 })!.installments).toBe(
      1,
    );
  });
});

describe('classFeeErrors', () => {
  it('hợp lệ / không học phí → rỗng', () => {
    expect(classFeeErrors(base)).toEqual({});
    expect(classFeeErrors({ ...base, feeType: null, feeAmount: null })).toEqual(
      {},
    );
  });

  it('chỉ có một trong feeType/feeAmount', () => {
    expect(Object.keys(classFeeErrors({ ...base, feeType: null }))).toEqual([
      'feeType',
    ]);
    expect(Object.keys(classFeeErrors({ ...base, feeAmount: null }))).toEqual([
      'feeAmount',
    ]);
  });

  it('course thiếu endDate hoặc lịch → lỗi ở feeType', () => {
    const c = { ...base, feeType: 'course' } as const;
    expect(Object.keys(classFeeErrors(c))).toEqual(['feeType']);
    expect(
      Object.keys(classFeeErrors({ ...c, endDate: '2027-05-31' })),
    ).toEqual(['feeType']);
    expect(Object.keys(classFeeErrors({ ...c, scheduleRuleCount: 2 }))).toEqual(
      ['feeType'],
    );
    expect(
      classFeeErrors({ ...c, endDate: '2027-05-31', scheduleRuleCount: 2 }),
    ).toEqual({});
  });

  it('quy tắc khi không có học phí, chia đợt khi không phải trọn khóa', () => {
    expect(
      Object.keys(
        classFeeErrors({
          ...base,
          feeType: null,
          feeAmount: null,
          feeRules: {},
        }),
      ),
    ).toEqual(['feeRules']);
    expect(
      Object.keys(classFeeErrors({ ...base, feeRules: { installments: 2 } })),
    ).toEqual(['feeRules.installments']);
  });
});
