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
    expect(planCarryOver(1_200_000, 200_000)).toEqual({
      total: 1_400_000,
      carryOver: 200_000,
      applied: 200_000,
    });
  });

  it('AC2: trả thừa 50.000 → dòng trừ 50.000, tổng 1.150.000, sổ về 0', () => {
    expect(planCarryOver(1_200_000, -50_000)).toEqual({
      total: 1_150_000,
      carryOver: -50_000,
      applied: -50_000,
    });
  });

  it('AC4: trả thừa 300.000 > phát sinh 100.000 → hóa đơn 0 đ, 200.000 ở lại sổ (hấp thụ 100.000)', () => {
    expect(planCarryOver(100_000, -300_000)).toEqual({
      total: 0,
      carryOver: -300_000,
      applied: -100_000,
    });
  });

  it('AC4 ca biên: trả thừa đúng bằng phát sinh → 0 đ, sổ về 0', () => {
    expect(planCarryOver(100_000, -100_000)).toEqual({
      total: 0,
      carryOver: -100_000,
      applied: -100_000,
    });
  });

  it('AC4 ca biên: hóa đơn 0 đ (phát sinh 0) vẫn giữ nguyên số dư trả thừa, không hấp thụ gì', () => {
    expect(planCarryOver(0, -80_000)).toEqual({
      total: 0,
      carryOver: -80_000,
      applied: 0,
    });
  });

  it('không có số dư: không có dòng, không bút toán', () => {
    expect(planCarryOver(900_000, 0)).toEqual({
      total: 900_000,
      carryOver: 0,
      applied: 0,
    });
  });

  it('điều chỉnh kỳ trước âm làm tổng âm: phần dư vào sổ (ghi có), không mất', () => {
    // phát sinh 0 + chênh −50.000, số dư 0 → sổ có 50.000 trả thừa
    expect(planCarryOver(-50_000, 0)).toEqual({
      total: 0,
      carryOver: 0,
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
  const rc = (id: string, amount: number) => ({
    sessionId: id,
    date: '2026-11-05',
    className: 'Toán 9A',
    amount,
  });

  it('buổi trước không tính, nay tính (sửa vắng → có mặt) → +tiền buổi', () => {
    const d = diffSessionCharges(
      new Map([['s1', 0]]),
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
      new Map([['s1', 200_000]]),
      [rc('s1', 0)],
      new Map(),
    );
    expect(d.map((x) => x.amount)).toEqual([-200_000]);
  });

  it('không đổi hoặc chỉ đổi đơn giá (cùng tính) → không chênh lệch', () => {
    expect(
      diffSessionCharges(
        new Map([['s1', 200_000]]),
        [rc('s1', 250_000)],
        new Map(),
      ),
    ).toEqual([]);
  });

  it('đã điều chỉnh ở hóa đơn sau thì không điều chỉnh lại; sửa về như cũ thì điều chỉnh ngược', () => {
    expect(
      diffSessionCharges(
        new Map([['s1', 0]]),
        [rc('s1', 200_000)],
        new Map([['s1', 200_000]]),
      ),
    ).toEqual([]);
    expect(
      diffSessionCharges(
        new Map([['s1', 0]]),
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
