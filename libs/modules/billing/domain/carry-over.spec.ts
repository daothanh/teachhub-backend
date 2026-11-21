import { describe, expect, it } from 'vitest';
import {
  diffSessionCharges,
  formatVnd,
  planCarryOver,
  prevAdjustmentDescription,
} from './carry-over.js';
import { calculateInvoice } from './invoice-calculator.js';

// Test vector US-7.6 AC1–AC4, US-3.3 AC4 (S6-BE-03). Mô hình: xem đầu carry-over.ts.
describe('planCarryOver (US-7.6)', () => {
  it('AC1: nợ 200.000 + phát sinh 1.200.000 → dòng nợ 200.000, tổng 1.400.000, sổ về 0', () => {
    expect(planCarryOver(1_200_000, 200_000)).toMatchObject({
      total: 1_400_000,
      carryOver: 200_000,
      applied: 200_000,
    });
  });

  it('AC2: trả thừa 50.000 → dòng trừ 50.000, tổng 1.150.000, sổ về 0', () => {
    expect(planCarryOver(1_200_000, -50_000)).toMatchObject({
      total: 1_150_000,
      carryOver: -50_000,
      applied: -50_000,
    });
  });

  it('AC4: trả thừa 300.000 > phát sinh 100.000 → hóa đơn 0 đ đã chốt, ghi nợ 100.000, dư 200.000 ở sổ', () => {
    expect(planCarryOver(100_000, -300_000)).toMatchObject({
      total: 0,
      carryOver: -300_000,
      issuable: true,
      applied: -100_000,
    });
  });

  it('AC4 ca biên: trả thừa đúng bằng phát sinh → 0 đ đã chốt, sổ về 0', () => {
    expect(planCarryOver(100_000, -100_000)).toMatchObject({
      total: 0,
      carryOver: -100_000,
      issuable: true,
      applied: -100_000,
    });
  });

  it('US-1.3 AC3: phát sinh 0 → không phát hành (issuable false), số dư trả thừa giữ nguyên', () => {
    expect(planCarryOver(0, -80_000)).toMatchObject({
      total: 0,
      carryOver: -80_000,
      issuable: false,
      applied: 0,
    });
  });

  it('phát sinh 0 thì tổng lưu luôn 0 dù có nợ cũ (nháp không chốt được)', () => {
    expect(planCarryOver(0, 100_000)).toMatchObject({
      total: 0,
      clamped: 0,
      issuable: false,
    });
  });

  it('không có số dư: không có dòng, không bút toán', () => {
    expect(planCarryOver(900_000, 0)).toMatchObject({
      total: 900_000,
      carryOver: 0,
      applied: 0,
    });
  });

  it('điều chỉnh âm vượt phát sinh: phần âm thành credit ở sổ (ghi có), hóa đơn 0 đ', () => {
    expect(planCarryOver(-50_000, 0)).toMatchObject({
      total: 0,
      carryOver: 0,
      issuable: true,
      applied: 50_000,
    });
    // −50.000 + nợ 30.000 → còn credit 20.000: ghi có 50.000 đối ứng với nợ 30.000 đã chuyển
    expect(planCarryOver(-50_000, 30_000)).toMatchObject({
      total: 0,
      applied: 50_000,
    });
  });

  it('khớp InvoiceCalculator: cùng tổng với dòng carry_over trong lines (nợ và trả thừa)', () => {
    const base = {
      feeType: 'monthly' as const,
      feeAmount: 1_200_000,
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      joinedOn: '2026-11-01',
      sessions: [],
      plannedSessions: 8,
    };
    for (const carry of [200_000, -50_000, -2_000_000]) {
      const r = calculateInvoice({ ...base, carryOver: carry });
      expect(planCarryOver(1_200_000, carry).total).toBe(r.total);
    }
  });
});

describe('diffSessionCharges (US-3.3 AC4)', () => {
  const iss = (...e: [string, number][]) =>
    new Map(
      e.map(([id, amount]) => [
        id,
        { amount, date: '2026-11-05', className: 'Toán 9A' },
      ]),
    );
  const rc = (id: string, amount: number) => ({
    sessionId: id,
    date: '2026-11-05',
    className: 'Toán 9A',
    amount,
  });

  it('buổi trước không tính, nay tính (sửa vắng → có mặt) → +tiền buổi', () => {
    const d = diffSessionCharges(
      iss(['s1', 0]),
      [rc('s1', 200_000)],
      new Map(),
    );
    expect(d).toEqual([
      {
        sessionId: 's1',
        date: '2026-11-05',
        className: 'Toán 9A',
        amount: 200_000,
      },
    ]);
  });

  it('buổi trước tính, nay không (có mặt → vắng có phép không tính) → −tiền đã phát hành', () => {
    const d = diffSessionCharges(
      iss(['s1', 200_000]),
      [rc('s1', 0)],
      new Map(),
    );
    expect(d.map((x) => x.amount)).toEqual([-200_000]);
  });

  it('không đổi hoặc chỉ đổi đơn giá (cùng tính) → không chênh lệch', () => {
    expect(
      diffSessionCharges(iss(['s1', 200_000]), [rc('s1', 250_000)], new Map()),
    ).toEqual([]);
  });

  it('đã điều chỉnh ở hóa đơn sau thì không điều chỉnh lại; sửa về như cũ thì điều chỉnh ngược', () => {
    expect(
      diffSessionCharges(
        iss(['s1', 0]),
        [rc('s1', 200_000)],
        new Map([['s1', 200_000]]),
      ),
    ).toEqual([]);
    expect(
      diffSessionCharges(
        iss(['s1', 0]),
        [rc('s1', 0)],
        new Map([['s1', 200_000]]),
      ).map((x) => x.amount),
    ).toEqual([-200_000]);
  });

  it('buổi chưa có trong hóa đơn đã phát hành (thêm sau) → tính thêm', () => {
    expect(
      diffSessionCharges(new Map(), [rc('s9', 150_000)], new Map()),
    ).toHaveLength(1);
  });

  it('buổi đã tính ở hóa đơn cũ nay bị hủy → dòng âm; buổi bị xóa hẳn → dòng âm; đã điều chỉnh rồi thì không lặp', () => {
    expect(
      diffSessionCharges(iss(['s1', 200_000]), [rc('s1', 0)], new Map()).map(
        (x) => x.amount,
      ),
    ).toEqual([-200_000]);
    const gone = new Set(['s2']);
    const d = diffSessionCharges(iss(['s2', 150_000]), [], new Map(), gone);
    expect(d).toEqual([
      {
        sessionId: 's2',
        date: '2026-11-05',
        className: 'Toán 9A',
        amount: -150_000,
      },
    ]);
    expect(
      diffSessionCharges(
        iss(['s2', 150_000]),
        [],
        new Map([['s2', -150_000]]),
        gone,
      ),
    ).toEqual([]);
    // không còn trong tính lại nhưng KHÔNG phải bị xóa (đổi lớp, đổi kiểu học phí): không điều chỉnh
    expect(diffSessionCharges(iss(['s3', 150_000]), [], new Map())).toEqual([]);
  });

  it('mô tả ghi rõ buổi, lớp và số tiền chênh', () => {
    expect(
      prevAdjustmentDescription({
        sessionId: 's1',
        date: '2026-11-05',
        className: 'Toán 9A',
        amount: 200_000,
      }),
    ).toBe(
      'Điều chỉnh kỳ trước: buổi 2026-11-05 (Toán 9A) tính thêm 200.000 đ',
    );
    expect(
      prevAdjustmentDescription({
        sessionId: 's1',
        date: '2026-11-05',
        className: 'Toán 9A',
        amount: -200_000,
      }),
    ).toBe('Điều chỉnh kỳ trước: buổi 2026-11-05 (Toán 9A) bỏ tính 200.000 đ');
    expect(formatVnd(1_400_000)).toBe('1.400.000');
  });
});
