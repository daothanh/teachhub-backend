import { describe, expect, it } from 'vitest';
import {
  type ClassFee,
  type ClassSession,
  computeEnrollmentInvoice,
  parseBillingSettings,
  parseFeeOverride,
  periodClosingOn,
  toCalcAttendance,
} from './billing-period.js';

const DEC = { periodMonth: '2026-12-01', periodEnd: '2026-12-31' };
const day = (d: number) => `2026-12-${String(d).padStart(2, '0')}`;
const session = (
  n: number,
  over: Partial<ClassSession> = {},
): ClassSession => ({
  id: `s${n}`,
  date: day(n),
  status: 'taught',
  isMakeup: false,
  makeupOf: null,
  ...over,
});
const eightTaught = Array.from({ length: 8 }, (_, i) => session(i + 1));
const perSession = (rules: unknown = null): ClassFee => ({
  className: 'Toán 9A',
  feeType: 'per_session',
  feeAmount: 150_000,
  feeRules: rules,
});
const enr = (over: Record<string, unknown> = {}) => ({
  studentId: 'st1',
  joinedOn: '2026-11-01',
  leftOn: null,
  feeOverride: null,
  ...over,
});
// Vắng 1 có phép (buổi 7) + 1 không phép (buổi 8), còn lại không có dòng điểm danh.
const att = new Map([
  ['s7', 'excused'],
  ['s8', 'unexcused'],
]);

describe('periodClosingOn: ngày chốt của kỳ', () => {
  const def = parseBillingSettings({});
  it('mặc định chốt ngày cuối tháng, hạn 10 ngày (khớp ví dụ hợp đồng)', () => {
    expect(periodClosingOn('2026-12-31', def)).toEqual({
      periodMonth: '2026-12-01',
      periodEnd: '2026-12-31',
      closeDate: '2026-12-31',
      dueDate: '2027-01-10',
    });
    expect(periodClosingOn('2026-12-30', def)).toBeNull();
    expect(periodClosingOn('2027-02-28', def)?.periodMonth).toBe('2027-02-01');
  });
  it('ngày chốt cấu hình 5: chỉ đúng ngày 5, hạn theo billingDueDays', () => {
    const s = parseBillingSettings({ billingCloseDay: 5, billingDueDays: 3 });
    expect(periodClosingOn('2027-01-05', s)).toMatchObject({
      periodMonth: '2027-01-01',
      periodEnd: '2027-01-31',
      closeDate: '2027-01-05',
      dueDate: '2027-01-08',
    });
    expect(periodClosingOn('2027-01-31', s)).toBeNull();
  });
  it('cấu hình sai kiểu hoặc ngoài khoảng → mặc định', () => {
    expect(
      parseBillingSettings({ billingCloseDay: 31, billingDueDays: -1 }),
    ).toEqual({
      closeDay: null,
      dueDays: 10,
    });
    expect(parseBillingSettings('x')).toEqual({ closeDay: null, dueDays: 10 });
  });
});

describe('computeEnrollmentInvoice: bản nháp từ buổi và điểm danh', () => {
  it('US-7.1 AC1: 8 buổi, vắng 1 có phép + 1 không phép, mặc định → 1.200.000', () => {
    const r = computeEnrollmentInvoice(
      perSession(),
      enr(),
      DEC,
      eightTaught,
      att,
    )!;
    expect(r.result.total).toBe(1_200_000);
    expect(r.result.lines).toHaveLength(8);
    expect(r.result.lines.every((l) => l.charged)).toBe(true);
  });
  it('US-7.1 AC2: lớp tắt tính vắng có phép → 1.050.000, dòng buổi vắng có phép 0 đ kèm lý do', () => {
    const r = computeEnrollmentInvoice(
      perSession({ chargeExcused: false }),
      enr(),
      DEC,
      eightTaught,
      att,
    )!;
    expect(r.result.total).toBe(1_050_000);
    const line = r.result.lines.find((l) => l.sessionId === 's7')!;
    expect(line).toMatchObject({
      amount: 0,
      charged: false,
      reason: 'excused_not_charged',
    });
  });
  it('US-7.1 AC2: học viên ghi đè tắt cả hai loại vắng → 900.000 (học sinh > lớp)', () => {
    const r = computeEnrollmentInvoice(
      perSession({ chargeExcused: false }),
      enr({ feeOverride: { chargeExcused: false, chargeUnexcused: false } }),
      DEC,
      eightTaught,
      att,
    )!;
    expect(r.result.total).toBe(900_000);
  });
  it('US-7.1 AC3: buổi hủy và buổi bù không phát sinh tiền; buổi chưa dạy không vào hóa đơn', () => {
    const sessions = [
      session(1),
      session(2, { status: 'cancelled' }),
      session(3, { isMakeup: true, makeupOf: 's2' }),
      session(4, { status: 'planned' }),
    ];
    const r = computeEnrollmentInvoice(
      perSession(),
      enr(),
      DEC,
      sessions,
      new Map(),
    )!;
    expect(r.result.total).toBe(150_000);
    expect(r.result.lines.map((l) => l.reason)).toEqual([
      'taught',
      'cancelled',
      'makeup',
    ]);
  });
  it('điểm danh `late` tính là có mặt (tính tiền)', () => {
    expect(toCalcAttendance('late')).toBe('present');
    expect(toCalcAttendance(undefined)).toBeNull();
  });
  it('học viên vào giữa kỳ: chỉ tính buổi từ ngày vào, buổi ngoài kỳ bị bỏ', () => {
    const sessions = [
      ...eightTaught,
      { ...session(1), id: 'old', date: '2026-11-30' },
    ];
    const r = computeEnrollmentInvoice(
      perSession(),
      enr({ joinedOn: day(5) }),
      DEC,
      sessions,
      new Map(),
    )!;
    expect(r.result.lines).toHaveLength(4); // buổi 5..8
  });

  it('US-7.1 AC4: theo tháng 1.000.000, lịch 8 buổi, hủy 1 không dạy bù, bật trừ → 875.000', () => {
    const cls: ClassFee = {
      className: 'Văn',
      feeType: 'monthly',
      feeAmount: 1_000_000,
      feeRules: { deductCancelled: true },
    };
    const sessions = [
      ...Array.from({ length: 7 }, (_, i) => session(i + 1)),
      session(8, { status: 'cancelled' }),
    ];
    expect(
      computeEnrollmentInvoice(cls, enr(), DEC, sessions, new Map())!.result
        .total,
    ).toBe(875_000);
    // Có buổi dạy bù cho buổi hủy: không trừ; buổi bù không tính vào số buổi theo lịch.
    const withMakeup = [
      ...sessions,
      session(9, { isMakeup: true, makeupOf: 's8' }),
    ];
    expect(
      computeEnrollmentInvoice(cls, enr(), DEC, withMakeup, new Map())!.result
        .total,
    ).toBe(1_000_000);
    // Tắt tùy chọn: 1.000.000.
    expect(
      computeEnrollmentInvoice(
        { ...cls, feeRules: null },
        enr(),
        DEC,
        sessions,
        new Map(),
      )!.result.total,
    ).toBe(1_000_000);
  });

  describe('trọn khóa', () => {
    const course: ClassFee = {
      className: 'Luyện thi',
      feeType: 'course',
      feeAmount: 3_600_000,
      feeRules: null,
    };
    const planned24 = Array.from({ length: 24 }, (_, i) =>
      session(i + 1, { status: 'planned' }),
    );
    it('US-7.1 AC5: khóa 24 buổi 3.600.000, vào khi còn 16 buổi → 2.400.000', () => {
      const r = computeEnrollmentInvoice(
        course,
        enr({ joinedOn: day(9) }),
        DEC,
        planned24,
        new Map(),
      )!;
      expect(r.result.total).toBe(2_400_000);
      expect(r.installmentNo).toBe(1);
      expect(r.installmentCount).toBe(1);
    });
    it('chia 2 đợt: đợt 1 là kỳ vào lớp, kỳ thứ 3 trở đi không sinh hóa đơn', () => {
      const two = { ...course, feeRules: { installments: 2 } };
      const r1 = computeEnrollmentInvoice(
        two,
        enr({ joinedOn: day(1) }),
        DEC,
        planned24,
        new Map(),
      )!;
      expect(r1.result.total).toBe(1_800_000);
      expect(r1.installmentCount).toBe(2);
      const r2 = computeEnrollmentInvoice(
        two,
        enr({ joinedOn: '2026-11-01' }),
        DEC,
        planned24,
        new Map(),
      )!;
      expect(r2.installmentNo).toBe(2);
      expect(
        computeEnrollmentInvoice(
          two,
          enr({ joinedOn: '2026-10-01' }),
          DEC,
          planned24,
          new Map(),
        ),
      ).toBeNull();
    });
    it('lớp chưa có buổi nào → không có dòng tiền', () => {
      expect(
        computeEnrollmentInvoice(course, enr(), DEC, [], new Map()),
      ).toBeNull();
    });
  });

  it('miễn giảm 100% của học viên → dòng gốc về 0 đ (US-1.3 AC3)', () => {
    const r = computeEnrollmentInvoice(
      {
        className: 'Văn',
        feeType: 'monthly',
        feeAmount: 1_000_000,
        feeRules: null,
      },
      enr({
        feeOverride: {
          discounts: [
            { kind: 'percent', percent: 100, description: 'Con giáo viên' },
          ],
        },
      }),
      DEC,
      [],
      new Map(),
    )!;
    expect(r.result.total).toBe(0);
    expect(r.result.lines.map((l) => l.kind)).toEqual(['monthly', 'discount']);
  });

  it('parseFeeOverride bỏ trường sai kiểu', () => {
    expect(
      parseFeeOverride({
        feeAmount: 'x',
        chargeExcused: false,
        discounts: [
          { kind: 'amount', amount: 50000, description: 'a' },
          { kind: 'percent' },
        ],
      }),
    ).toEqual({
      override: { chargeExcused: false },
      discounts: [{ kind: 'amount', value: 50000, description: 'a' }],
    });
  });
});
