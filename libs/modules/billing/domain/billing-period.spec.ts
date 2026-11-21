import { describe, expect, it } from 'vitest';
import {
  type ClassFee,
  type ClassSession,
  closablePeriods,
  computeEnrollmentInvoice,
  parseBillingSettings,
  parseFeeOverride,
  latestClosablePeriod,
  studentPeriodState,
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

describe('latestClosablePeriod: kỳ M chốt ngày billingCloseDay của tháng M+1 (D1, D2)', () => {
  const def = parseBillingSettings({});
  it('mặc định chốt ngày 1 tháng sau, hạn 10 ngày', () => {
    expect(latestClosablePeriod('2027-01-01', def)).toEqual({
      periodMonth: '2026-12-01',
      periodEnd: '2026-12-31',
      closeDate: '2027-01-01',
      dueDate: '2027-01-11',
      isCloseDay: true,
    });
    // Hôm sau: vẫn kỳ 12/2026 nhưng không còn là ngày chốt (lỡ ngày chốt thì đang bù).
    expect(latestClosablePeriod('2027-01-15', def)).toMatchObject({
      periodMonth: '2026-12-01',
      isCloseDay: false,
    });
    expect(latestClosablePeriod('2027-03-01', def)).toMatchObject({
      periodMonth: '2027-02-01',
      periodEnd: '2027-02-28',
    });
  });
  it('ngày chốt 5: trước ngày 5 kỳ mới nhất là kỳ trước nữa, từ ngày 5 là kỳ liền trước', () => {
    const s = parseBillingSettings({ billingCloseDay: 5, billingDueDays: 3 });
    expect(latestClosablePeriod('2027-01-04', s)).toMatchObject({
      periodMonth: '2026-11-01',
      closeDate: '2026-12-05',
      isCloseDay: false,
    });
    expect(latestClosablePeriod('2027-01-05', s)).toEqual({
      periodMonth: '2026-12-01',
      periodEnd: '2026-12-31',
      closeDate: '2027-01-05',
      dueDate: '2027-01-08',
      isCloseDay: true,
    });
  });
  it('các kỳ liền kề không hở không chồng (qua năm)', () => {
    const s = parseBillingSettings({ billingCloseDay: 28 });
    const a = latestClosablePeriod('2027-01-28', s);
    const b = latestClosablePeriod('2027-02-28', s);
    expect([a.periodMonth, a.periodEnd]).toEqual(['2026-12-01', '2026-12-31']);
    expect([b.periodMonth, b.periodEnd]).toEqual(['2027-01-01', '2027-01-31']);
  });
  it('cấu hình sai kiểu hoặc ngoài khoảng → mặc định', () => {
    expect(
      parseBillingSettings({ billingCloseDay: 31, billingDueDays: -1 }),
    ).toEqual({ closeDay: 1, dueDays: 10 });
    expect(parseBillingSettings('x')).toEqual({ closeDay: 1, dueDays: 10 });
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
  it('US-7.1 AC3: buổi hủy và buổi bù không phát sinh tiền; buổi chưa dạy chỉ là dòng 0 đ chưa điểm danh (D3)', () => {
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
      'not_marked',
    ]);
    expect(r.result.lines.map((l) => l.amount)).toEqual([150_000, 0, 0, 0]);
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

  it('D3: buổi planned quá khứ → dòng 0 đ "chưa điểm danh" xen đúng thứ tự ngày, tổng không đổi', () => {
    const sessions = [
      session(1),
      session(2, { status: 'planned' }),
      session(3),
    ];
    const r = computeEnrollmentInvoice(
      perSession(),
      enr(),
      DEC,
      sessions,
      new Map(),
    )!;
    expect(r.result.total).toBe(300_000);
    expect(r.result.lines.map((l) => [l.sessionId, l.amount])).toEqual([
      ['s1', 150_000],
      ['s2', 0],
      ['s3', 150_000],
    ]);
    expect(r.result.lines[1]!.description).toContain('chưa điểm danh');
    expect(r.result.lines[1]).toMatchObject({
      charged: false,
      reason: 'not_marked',
    });
  });
  it('D3: lớp theo tháng không phụ thuộc điểm danh; buổi planned vẫn nằm trong mẫu số lịch', () => {
    const cls: ClassFee = {
      className: 'Văn',
      feeType: 'monthly',
      feeAmount: 1_000_000,
      feeRules: { deductCancelled: true },
    };
    const sessions = [
      session(1, { status: 'planned' }),
      session(2, { status: 'planned' }),
      session(3, { status: 'planned' }),
      session(4, { status: 'cancelled' }),
    ];
    // 4 buổi theo lịch, hủy 1 không bù: 1.000.000 − 1.000.000/4 = 750.000
    expect(
      computeEnrollmentInvoice(cls, enr(), DEC, sessions, new Map())!.result
        .total,
    ).toBe(750_000);
  });
  it('D4: học viên tạm nghỉ chỉ còn tiền theo buổi, không thu tháng/trọn khóa', () => {
    const paused = { paused: true };
    expect(
      computeEnrollmentInvoice(
        perSession(),
        enr(),
        DEC,
        eightTaught,
        new Map(),
        paused,
      )!.result.total,
    ).toBe(1_200_000);
    const monthly: ClassFee = {
      className: 'V',
      feeType: 'monthly',
      feeAmount: 1_000_000,
      feeRules: null,
    };
    const course: ClassFee = {
      className: 'C',
      feeType: 'course',
      feeAmount: 3_600_000,
      feeRules: null,
    };
    expect(
      computeEnrollmentInvoice(monthly, enr(), DEC, [], new Map(), paused),
    ).toBeNull();
    expect(
      computeEnrollmentInvoice(
        course,
        enr(),
        DEC,
        eightTaught,
        new Map(),
        paused,
      ),
    ).toBeNull();
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

describe('studentPeriodState: trạng thái học viên theo kỳ từ lịch sử (D4, issue #179)', () => {
  const ch = (from: string, to: string, on: string) => ({ from, to, on });
  const st = (
    current: string,
    history: ReturnType<typeof ch>[],
    end = DEC.periodEnd,
  ) => studentPeriodState(current, history, end);
  const JAN_END = '2027-01-31';
  const FEB_END = '2027-02-28';

  it('đổi sang left/paused SAU cuối kỳ (giữa ngày 1 và ngày chốt) → kỳ vẫn xét như trước khi đổi', () => {
    expect(st('left', [ch('active', 'left', '2027-01-03')])).toEqual({
      paused: false,
      leftOn: null,
    });
    expect(st('paused', [ch('active', 'paused', '2027-01-03')])).toEqual({
      paused: false,
      leftOn: null,
    });
    expect(st('left', [ch('paused', 'left', '2027-01-03')])).toEqual({
      paused: true,
      leftOn: null,
    });
  });

  it('left trong kỳ → leftOn = ngày rời; paused từ trong kỳ → chỉ buổi theo buổi', () => {
    expect(st('left', [ch('active', 'left', '2026-12-20')])).toEqual({
      paused: false,
      leftOn: '2026-12-20',
    });
    expect(st('paused', [ch('active', 'paused', '2026-12-05')])).toEqual({
      paused: true,
      leftOn: null,
    });
  });

  it('chưa có lịch sử (học viên đổi trước migration 0034): left không tính, paused theo D4, active đủ', () => {
    expect(st('left', [])).toBeNull();
    expect(st('paused', [])).toEqual({ paused: true, leftOn: null });
    expect(st('active', [])).toEqual({ paused: false, leftOn: null });
  });

  it('kịch bản 1 (catch-up): active → paused 10/02 → active 05/03: kỳ 01/2027 là active (đủ), kỳ 02/2027 là paused', () => {
    const h = [
      ch('active', 'paused', '2027-02-10'),
      ch('paused', 'active', '2027-03-05'),
    ];
    expect(st('active', h, JAN_END)).toEqual({ paused: false, leftOn: null });
    expect(st('active', h, FEB_END)).toEqual({ paused: true, leftOn: null });
  });

  it('kịch bản 2 (catch-up): left 20/12 → active 05/03: kỳ 12/2026 leftOn = 20/12 (không phải 05/03); kỳ 01/2027 không có dòng; từ 03/2027 active', () => {
    const h = [
      ch('active', 'left', '2026-12-20'),
      ch('left', 'active', '2027-03-05'),
    ];
    expect(st('active', h, DEC.periodEnd)).toEqual({
      paused: false,
      leftOn: '2026-12-20',
    });
    expect(st('active', h, JAN_END)).toEqual({
      paused: false,
      leftOn: '2026-12-20',
    });
    expect(st('active', h, '2027-03-31')).toEqual({
      paused: false,
      leftOn: null,
    });
  });

  it('vector tiền: left ngày 03/01 (sau kỳ) vẫn bị tính 8 buổi → 1.200.000; left 05/12 (trong kỳ) → 4 buổi 600.000; kịch bản 2 kỳ 12/2026 → 9 buổi?: chỉ buổi trước 20/12', () => {
    const money = (
      state: NonNullable<ReturnType<typeof st>>,
      att2: ReadonlyMap<string, string>,
    ) =>
      computeEnrollmentInvoice(
        perSession(),
        enr({ leftOn: state.leftOn }),
        DEC,
        eightTaught,
        att2,
        { paused: state.paused },
      )!.result.lines.reduce((n, l) => n + l.amount, 0);
    expect(money(st('left', [ch('active', 'left', '2027-01-03')])!, att)).toBe(
      1_200_000,
    );
    expect(
      money(st('left', [ch('active', 'left', '2026-12-05')])!, new Map()),
    ).toBe(600_000);
    // kịch bản 2: rời 20/12, hồi lại 05/03 → kỳ 12/2026 tính cả 8 buổi (đều trước 20/12), không bị chặn như đang active sau này.
    expect(
      money(
        st('active', [
          ch('active', 'left', '2026-12-20'),
          ch('left', 'active', '2027-03-05'),
        ])!,
        new Map(),
      ),
    ).toBe(1_200_000);
  });
});

describe('closablePeriods: catch-up mọi kỳ còn thiếu, cũ → mới (D1, issue #179)', () => {
  const s1 = parseBillingSettings({});
  const s5 = parseBillingSettings({ billingCloseDay: 5, billingDueDays: 10 });
  const months = (ps: { periodMonth: string }[]) =>
    ps.map((p) => p.periodMonth);

  it('tenant chưa có kỳ nào: chỉ kỳ mới nhất', () => {
    expect(months(closablePeriods('2027-03-10', s1, null))).toEqual([
      '2027-02-01',
    ]);
  });

  it('worker dừng từ tháng 1: kỳ cuối đã có là 12/2026, hôm nay 10/03 → 01 và 02/2027, đúng thứ tự', () => {
    const ps = closablePeriods('2027-03-10', s1, '2026-12-01');
    expect(months(ps)).toEqual(['2027-01-01', '2027-02-01']);
    expect(ps[0]).toMatchObject({
      periodEnd: '2027-01-31',
      closeDate: '2027-02-01',
      dueDate: '2027-02-11',
      isCloseDay: false,
    });
    expect(ps[1]).toMatchObject({
      periodEnd: '2027-02-28',
      closeDate: '2027-03-01',
      dueDate: '2027-03-11',
    });
  });

  it('ngày chốt 5, hôm nay 03/03 (chưa tới ngày chốt tháng 3): kỳ mới nhất là 01/2027; qua năm', () => {
    expect(months(closablePeriods('2027-03-03', s5, '2026-11-01'))).toEqual([
      '2026-12-01',
      '2027-01-01',
    ]);
    expect(closablePeriods('2027-03-03', s5, '2026-11-01')[0]).toMatchObject({
      closeDate: '2027-01-05',
      dueDate: '2027-01-15',
    });
  });

  it('kỳ mới nhất đã có: vẫn trả đúng kỳ đó (để chạy lại đúng ngày chốt); chặn ở 12 kỳ', () => {
    expect(months(closablePeriods('2027-03-10', s1, '2027-02-01'))).toEqual([
      '2027-02-01',
    ]);
    expect(closablePeriods('2030-03-10', s1, '2026-01-01')).toHaveLength(12);
  });
});

describe('trọn khóa: tổng buổi theo cấu hình lớp (US-7.1 AC5, issue #179)', () => {
  const course = (courseDates: string[] | null): ClassFee => ({
    className: 'Luyện thi',
    feeType: 'course',
    feeAmount: 3_600_000,
    feeRules: null,
    courseDates,
  });
  const dates24 = Array.from({ length: 24 }, (_, i) => day(i + 1));
  const total = (r: ReturnType<typeof computeEnrollmentInvoice>) =>
    r!.result.lines.reduce((n, l) => n + l.amount, 0);

  it('khóa 24 buổi 3.600.000 đ, vào khi còn 16 buổi → 2.400.000 (không phụ thuộc số buổi đã sinh)', () => {
    // Chỉ mới sinh 8 buổi cuốn chiếu: shortcut cũ sẽ tính 3.600.000 × 8/8.
    const r = computeEnrollmentInvoice(
      course(dates24),
      enr({ joinedOn: day(9) }),
      DEC,
      eightTaught,
      new Map(),
    );
    expect(total(r)).toBe(2_400_000);
    expect(r).toMatchObject({ installmentNo: 1, installmentCount: 1 });
  });

  it('vào từ đầu khóa → đủ 3.600.000; vào sau ngày cuối khóa → không có dòng', () => {
    expect(
      total(
        computeEnrollmentInvoice(
          course(dates24),
          enr({ joinedOn: day(1) }),
          DEC,
          [],
          new Map(),
        ),
      ),
    ).toBe(3_600_000);
    expect(
      computeEnrollmentInvoice(
        course(dates24),
        enr({ joinedOn: day(25) }),
        DEC,
        [],
        new Map(),
      ),
    ).toBeNull();
  });

  it('thiếu cấu hình (courseDates null) → shortcut cũ: đếm buổi chưa hủy hiện có', () => {
    const r = computeEnrollmentInvoice(
      course(null),
      enr({ joinedOn: day(5) }),
      DEC,
      eightTaught,
      new Map(),
    );
    expect(total(r)).toBe(1_800_000); // 3.600.000 × 4/8
  });
});
