import {
  allocate,
  type ClassKey,
  type InvoiceLine,
  invoiceWeights,
  OTHER,
} from './revenue-allocation.js';

const line = (
  kind: string,
  amount: number,
  classId: string | null,
  charged = true,
): InvoiceLine => ({ kind, amount, charged, classId });
const sum = (m: Map<ClassKey, number>) =>
  [...m.values()].reduce((a, b) => a + b, 0);
const obj = (m: Map<ClassKey, number>) =>
  Object.fromEntries([...m].map(([k, v]) => [k ?? 'other', v]));
const split = (amount: number, lines: InvoiceLine[]) =>
  allocate(amount, invoiceWeights(lines));

describe('chia doanh thu theo lớp (US-8.2 AC3)', () => {
  it('hóa đơn hai lớp, thu đủ: mỗi lớp đúng số học phí', () => {
    const r = split(1_500_000, [
      line('monthly', 1_000_000, 'A'),
      line('session', 500_000, 'B'),
    ]);
    expect(obj(r)).toEqual({ A: 1_000_000, B: 500_000 });
  });

  it('thu một phần: chia theo tỷ lệ, tổng đúng số thu', () => {
    const r = split(600_000, [
      line('monthly', 1_000_000, 'A'),
      line('session', 500_000, 'B'),
    ]);
    expect(obj(r)).toEqual({ A: 400_000, B: 200_000 });
  });

  it('làm tròn phần dư lớn nhất: 100 đồng chia 1:1:1', () => {
    const r = split(100, [
      line('monthly', 10, 'A'),
      line('monthly', 10, 'B'),
      line('monthly', 10, 'C'),
    ]);
    // 33 dư 1 mỗi lớp; hòa phần dư thì khóa nhỏ trước → A nhận đồng lẻ
    expect(obj(r)).toEqual({ A: 34, B: 33, C: 33 });
    expect(sum(r)).toBe(100);
  });

  it('phần dư lớn nhất thắng khi không hòa', () => {
    // 10 chia 1:2 → 3.33 / 6.67 → B nhận đồng lẻ
    expect(
      obj(split(10, [line('monthly', 1, 'A'), line('monthly', 2, 'B')])),
    ).toEqual({
      A: 3,
      B: 7,
    });
  });

  it('nợ kỳ trước vào "Khác" theo tỷ lệ; thu đủ thì lớp nhận đúng học phí', () => {
    const r = split(1_200_000, [
      line('monthly', 1_000_000, 'A'),
      line('carry_over', 200_000, null),
    ]);
    expect(obj(r)).toEqual({ A: 1_000_000, other: 200_000 });
  });

  it('điều chỉnh tay dương và dòng học phí không xác định lớp vào "Khác"', () => {
    const r = split(900, [
      line('monthly', 600, 'A'),
      line('manual_adjustment', 100, null),
      line('prev_adjustment', 100, 'A'),
      line('surcharge', 100, null),
    ]);
    expect(obj(r)).toEqual({ A: 600, other: 300 });
  });

  it('dòng âm và dòng không tính phí không có trọng số', () => {
    const r = split(1_000, [
      line('monthly', 1_000, 'A'),
      line('discount', -300, 'A'),
      line('session', 0, 'B', false),
    ]);
    expect(obj(r)).toEqual({ A: 1_000 });
  });

  it('không có trọng số (chỉ dòng âm): toàn bộ vào "Khác"', () => {
    expect(obj(split(500, [line('discount', -100, 'A')]))).toEqual({
      other: 500,
    });
  });

  it('dòng đảo chia ngược đúng từng đồng phần của khoản thu gốc', () => {
    const lines = [
      line('monthly', 10, 'A'),
      line('monthly', 10, 'B'),
      line('monthly', 10, 'C'),
    ];
    const pay = split(100, lines);
    const rev = split(-100, lines);
    for (const [k, v] of pay) expect(rev.get(k)).toBe(-v);
    expect(sum(rev)).toBe(-100);
  });

  it('số tiền lớn không tràn 2^53', () => {
    const r = split(999_999_999_999, [
      line('monthly', 999_999_999_999, 'A'),
      line('monthly', 999_999_999_998, 'B'),
    ]);
    expect(sum(r)).toBe(999_999_999_999);
  });

  it('thuộc tính: tổng luôn bằng đúng số tiền', () => {
    for (let amount = 1; amount < 400; amount += 7)
      for (const w of [
        [1, 1, 1],
        [3, 5, 7],
        [1, 999, 13],
      ]) {
        const lines = w.map((x, i) => line('monthly', x, `c${i}`));
        expect(sum(split(amount, lines))).toBe(amount);
        expect(sum(split(-amount, lines))).toBe(-amount);
      }
    expect(OTHER).toBeNull();
  });
});
