import { describe, expect, it } from 'vitest';
import {
  calculateInvoice,
  round1000,
  splitInstallments,
  type InvoiceInput,
  type SessionInput,
} from './invoice-calculator.js';

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;
const taught = (
  n: number,
  attendance: SessionInput['attendance'] = 'present',
): SessionInput => ({
  id: `s${n}`,
  date: day(n),
  status: 'taught',
  isMakeup: false,
  attendance,
});
const base = {
  periodStart: day(1),
  periodEnd: day(30),
  joinedOn: '2026-01-01',
};

/** 8 buổi đã dạy: 6 có mặt, 1 vắng có phép, 1 vắng không phép. */
const eightTaught = (): SessionInput[] => [
  ...[1, 2, 3, 4, 5, 6].map((n) => taught(n)),
  taught(7, 'excused'),
  taught(8, 'unexcused'),
];
const perSession = (extra: Partial<InvoiceInput> = {}): InvoiceInput => ({
  ...base,
  feeType: 'per_session',
  feeAmount: 150_000,
  sessions: eightTaught(),
  ...extra,
});

describe('làm tròn 1.000 đ (US-7.1 AC6, Spec 4.7)', () => {
  it.each([
    [888_889, 889_000],
    [499, 0],
    [500, 1000],
    [1499, 1000],
    [1500, 2000],
  ])('round_1000(%i) = %i', (x, y) => expect(round1000(x)).toBe(y));
});

describe('theo buổi (US-7.1 AC1-AC3)', () => {
  it('AC1: mặc định tính cả hai loại vắng = 8 × 150.000', () => {
    expect(calculateInvoice(perSession()).total).toBe(1_200_000);
  });
  it('AC2: lớp tắt tính vắng có phép = 7 × 150.000', () => {
    expect(
      calculateInvoice(perSession({ classRules: { chargeExcused: false } }))
        .total,
    ).toBe(1_050_000);
  });
  it('AC2: học sinh ghi đè tắt cả hai loại vắng = 6 × 150.000 (học sinh > lớp > mặc định)', () => {
    const r = calculateInvoice(
      perSession({
        classRules: { chargeExcused: true },
        override: { chargeExcused: false, chargeUnexcused: false },
      }),
    );
    expect(r.total).toBe(900_000);
  });
  it('AC2: ghi đè giá riêng của học sinh thay đơn giá lớp (US-1.3 AC1)', () => {
    expect(
      calculateInvoice(perSession({ override: { feeAmount: 100_000 } })).total,
    ).toBe(800_000);
  });
  it('AC3: buổi GV hủy và buổi bù không phát sinh tiền', () => {
    const sessions = [
      taught(1),
      { ...taught(2), status: 'cancelled' as const, attendance: null },
      { ...taught(3), isMakeup: true },
    ];
    expect(calculateInvoice(perSession({ sessions })).total).toBe(150_000);
  });
  it('Spec 4.7: chỉ tính buổi trong kỳ, sau joined_on, trước left_on', () => {
    const sessions = [
      taught(1),
      taught(5),
      taught(10),
      { ...taught(11), date: '2026-12-01' },
    ];
    const r = calculateInvoice(
      perSession({ sessions, joinedOn: day(5), leftOn: day(10) }),
    );
    expect(r.total).toBe(150_000); // chỉ ngày 5
  });
  it('mỗi buổi là một dòng, buổi không tính có amount 0 (US-7.2 AC2)', () => {
    const r = calculateInvoice(
      perSession({ classRules: { chargeUnexcused: false } }),
    );
    expect(r.lines).toHaveLength(8);
    expect(r.lines.filter((l) => l.amount === 0)).toHaveLength(1);
  });
});

describe('theo tháng (US-7.1 AC4, US-2.6 AC4)', () => {
  const monthly = (extra: Partial<InvoiceInput> = {}): InvoiceInput => ({
    ...base,
    feeType: 'monthly',
    feeAmount: 1_000_000,
    plannedSessions: 8,
    sessions: [
      taught(1),
      { ...taught(2), status: 'cancelled', attendance: null },
    ],
    ...extra,
  });
  it('AC4: bật trừ buổi hủy = 1.000.000 − 125.000', () => {
    expect(
      calculateInvoice(monthly({ classRules: { deductCancelled: true } }))
        .total,
    ).toBe(875_000);
  });
  it('AC4: tắt tùy chọn = 1.000.000', () => {
    expect(calculateInvoice(monthly()).total).toBe(1_000_000);
  });
  it('AC4: buổi hủy đã dạy bù không bị trừ', () => {
    const sessions = [
      {
        ...taught(2),
        status: 'cancelled' as const,
        madeUp: true,
        attendance: null,
      },
    ];
    expect(
      calculateInvoice(
        monthly({ sessions, classRules: { deductCancelled: true } }),
      ).total,
    ).toBe(1_000_000);
  });
  it('US-2.6 AC4: ngày lễ bỏ qua (không có buổi) thì không trừ tiền', () => {
    expect(
      calculateInvoice(
        monthly({
          sessions: [taught(1)],
          classRules: { deductCancelled: true },
        }),
      ).total,
    ).toBe(1_000_000);
  });
  it('AC6: phần trừ chia tỷ lệ làm tròn 1.000 đ (1/9 → 111.000 → 889.000)', () => {
    const r = calculateInvoice(
      monthly({ plannedSessions: 9, classRules: { deductCancelled: true } }),
    );
    expect(r.total).toBe(889_000);
  });
});

describe('trọn khóa (US-7.1 AC5, AC6)', () => {
  const course = (extra: Partial<InvoiceInput> = {}): InvoiceInput => ({
    ...base,
    feeType: 'course',
    feeAmount: 3_600_000,
    totalSessions: 24,
    remainingSessions: 16,
    sessions: [],
    ...extra,
  });
  it('AC5: vào khi còn 16/24 buổi = 2.400.000', () => {
    expect(calculateInvoice(course()).total).toBe(2_400_000);
  });
  it('AC5: chia đúng số đợt đã cấu hình', () => {
    const parts = [1, 2, 3].map(
      (n) =>
        calculateInvoice(
          course({ classRules: { installments: 3 }, installmentNo: n }),
        ).total,
    );
    expect(parts).toEqual([800_000, 800_000, 800_000]);
  });
  it('AC6: đợt cuối gánh chênh, Σ đợt = tổng khóa', () => {
    expect(splitInstallments(1_000_000, 3)).toEqual([
      333_000, 333_000, 334_000,
    ]);
  });
  it('AC6: chia tỷ lệ làm tròn 1.000 đ', () => {
    // 1.000.000 × 1/9 = 111.111 → 111.000
    expect(
      calculateInvoice(
        course({
          feeAmount: 1_000_000,
          totalSessions: 9,
          remainingSessions: 1,
        }),
      ).total,
    ).toBe(111_000);
  });
  it('đợt không vượt phần còn lại (không có đợt âm)', () => {
    expect(splitInstallments(2000, 4).every((x) => x >= 0)).toBe(true);
  });
});

describe('miễn giảm, số dư chuyển kỳ (US-1.3 AC3, US-7.6)', () => {
  it('US-1.3 AC3: miễn giảm 100% → 0 đ', () => {
    const r = calculateInvoice(
      perSession({
        discounts: [{ kind: 'percent', value: 100, description: 'Miễn' }],
      }),
    );
    expect(r.total).toBe(0);
  });
  it('giảm 10% làm tròn 1.000 đ', () => {
    const r = calculateInvoice(
      perSession({
        discounts: [{ kind: 'percent', value: 10, description: 'Giảm' }],
      }),
    );
    expect(r.total).toBe(1_080_000);
  });
  it('giảm cố định không vượt phần gốc', () => {
    const r = calculateInvoice(
      perSession({
        discounts: [{ kind: 'amount', value: 5_000_000, description: 'Giảm' }],
      }),
    );
    expect(r.total).toBe(0);
  });
  it('US-7.6 AC1: nợ kỳ trước 200.000 + 1.200.000 = 1.400.000', () => {
    const r = calculateInvoice(perSession({ carryOver: 200_000 }));
    expect(r.total).toBe(1_400_000);
    expect(
      r.lines.some((l) => l.kind === 'carry_over' && l.amount === 200_000),
    ).toBe(true);
  });
  it('US-7.6 AC2: trả thừa 50.000 → dòng trừ', () => {
    expect(calculateInvoice(perSession({ carryOver: -50_000 })).total).toBe(
      1_150_000,
    );
  });
  it('US-7.6 AC3: điều chỉnh kỳ trước có dấu', () => {
    const r = calculateInvoice(
      perSession({
        prevAdjustments: [
          { sessionId: 'x', amount: -150_000, description: 'Điều chỉnh' },
        ],
      }),
    );
    expect(r.total).toBe(1_050_000);
  });
  it('US-7.6 AC4: tổng âm → 0 đ, phần dư tiếp tục chuyển kỳ', () => {
    const r = calculateInvoice(perSession({ carryOver: -1_500_000 }));
    expect(r.total).toBe(0);
    expect(r.creditCarriedForward).toBe(300_000);
  });
  it('Spec 4.7: phụ thu một lần được cộng', () => {
    expect(
      calculateInvoice(
        perSession({
          surcharges: [{ description: 'Tài liệu', amount: 50_000 }],
        }),
      ).total,
    ).toBe(1_250_000);
  });
  it('từ chối tiền không phải số nguyên', () => {
    expect(() => calculateInvoice(perSession({ feeAmount: 1.5 }))).toThrow(
      RangeError,
    );
  });
});

describe('bất biến (AC-3, bảng ví dụ + sinh giả ngẫu nhiên cố định seed)', () => {
  // LCG xác định: không thêm dependency fast-check
  let seed = 42;
  const rnd = (n: number) => (
    (seed = (seed * 1103515245 + 12345) % 2 ** 31),
    seed % n
  );
  const cases: InvoiceInput[] = Array.from({ length: 300 }, () => {
    const type = (['per_session', 'monthly', 'course'] as const)[rnd(3)]!;
    const sessions = Array.from({ length: rnd(12) }, (_, i) => ({
      ...taught(
        i + 1,
        ([null, 'present', 'excused', 'unexcused'] as const)[rnd(4)]!,
      ),
      status: rnd(4) === 0 ? ('cancelled' as const) : ('taught' as const),
      isMakeup: rnd(5) === 0,
      madeUp: rnd(2) === 0,
    }));
    const totalSessions = 1 + rnd(30);
    return {
      ...base,
      feeType: type,
      feeAmount: (1 + rnd(5000)) * 1000 + rnd(1000),
      classRules: {
        chargeExcused: rnd(2) === 0,
        chargeUnexcused: rnd(2) === 0,
        deductCancelled: true,
        installments: 1 + rnd(5),
      },
      plannedSessions: 1 + rnd(31),
      totalSessions,
      remainingSessions: rnd(totalSessions + 1),
      installmentNo: 1,
      sessions,
      carryOver: rnd(3) === 0 ? rnd(2_000_000) - 1_000_000 : 0,
      discounts:
        rnd(3) === 0
          ? [{ kind: 'percent' as const, value: rnd(101), description: 'g' }]
          : [],
    };
  });
  it('tổng dòng = tổng hóa đơn + phần dư chuyển kỳ; total ≥ 0; mọi số là số nguyên', () => {
    for (const c of cases) {
      const r = calculateInvoice(c);
      const sum = r.lines.reduce((a, l) => a + l.amount, 0);
      expect(r.total - r.creditCarriedForward).toBe(sum);
      expect(r.total).toBeGreaterThanOrEqual(0);
      expect(r.creditCarriedForward).toBeGreaterThanOrEqual(0);
      expect(r.total === 0 || r.creditCarriedForward === 0).toBe(true);
      expect(
        [r.total, ...r.lines.map((l) => l.amount)].every(Number.isSafeInteger),
      ).toBe(true);
    }
  });
  it('dòng gốc/giảm giá không âm trừ khi là số dư chuyển kỳ, điều chỉnh hoặc giảm giá', () => {
    for (const c of cases) {
      for (const l of calculateInvoice(c).lines) {
        if (
          ['session', 'monthly', 'course_installment', 'surcharge'].includes(
            l.kind,
          )
        )
          expect(l.amount).toBeGreaterThanOrEqual(0);
        if (l.kind === 'discount') expect(l.amount).toBeLessThanOrEqual(0);
      }
    }
  });
  it('Σ đợt = tổng khóa và mọi đợt ≥ 0', () => {
    for (let i = 0; i < 300; i++) {
      const total = rnd(10_000_000);
      const n = 1 + rnd(12);
      const parts = splitInstallments(total, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
  });
});
