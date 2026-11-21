// Chia doanh thu theo lớp (US-8.2 AC3). Hàm thuần: không phụ thuộc Nest/Drizzle. Tiền là số nguyên đồng.

/** Khóa của phần không gán được cho lớp nào ("Khác" ở T12). */
export const OTHER = null;
export type ClassKey = string | typeof OTHER;

export interface InvoiceLine {
  kind: string;
  amount: number;
  charged: boolean;
  /** Lớp của dòng; null khi không xác định được (dòng không gắn lớp, hoặc lớp bị xóa/trùng tên). */
  classId: string | null;
}

/** Dòng học phí: chỉ các loại này mới tạo trọng số cho lớp (US-8.2 AC3); mọi dòng dương khác thuộc "Khác". */
const TUITION_KINDS = new Set([
  'session',
  'monthly',
  'course_installment',
  'surcharge',
]);

/**
 * Trọng số của hóa đơn: Σ dòng dương theo lớp (loại học phí, có lớp); mọi dòng dương còn lại (nợ kỳ trước, điều chỉnh
 * tay, phụ thu không gắn lớp, ...) cộng vào "Khác". Dòng âm (giảm trừ) và dòng không tính phí không có trọng số.
 */
export function invoiceWeights(lines: InvoiceLine[]): Map<ClassKey, number> {
  const w = new Map<ClassKey, number>();
  for (const l of lines) {
    if (!l.charged || l.amount <= 0) continue;
    const key: ClassKey =
      TUITION_KINDS.has(l.kind) && l.classId ? l.classId : OTHER;
    w.set(key, (w.get(key) ?? 0) + l.amount);
  }
  return w;
}

/**
 * Chia `amount` (có dấu) theo trọng số, làm tròn phần dư lớn nhất: Σ kết quả = đúng `amount`. Hòa phần dư thì lớp có khóa
 * nhỏ hơn trước ("Khác" sau cùng) để kết quả ổn định. Không có trọng số nào thì toàn bộ vào "Khác".
 * Số âm (dòng đảo) chia theo trị tuyệt đối rồi đổi dấu, nên đảo đúng từng đồng phần đã chia của khoản thu gốc.
 */
export function allocate(
  amount: number,
  weights: Map<ClassKey, number>,
): Map<ClassKey, number> {
  const total = [...weights.values()].reduce((n, v) => n + v, 0);
  if (total <= 0 || amount === 0) return new Map([[OTHER, amount]]);
  const abs = Math.abs(amount);
  const order = [...weights.keys()].sort((a, b) =>
    a === b ? 0 : a === OTHER ? 1 : b === OTHER ? -1 : a! < b! ? -1 : 1,
  );
  const base = new Map<ClassKey, number>();
  const rem: { key: ClassKey; r: number }[] = [];
  let given = 0;
  for (const k of order) {
    // BigInt: abs <= 1e12 và trọng số <= 1e12 nhân nhau vượt 2^53.
    const num = BigInt(abs) * BigInt(weights.get(k)!);
    const q = Number(num / BigInt(total));
    base.set(k, q);
    given += q;
    rem.push({ key: k, r: Number(num % BigInt(total)) });
  }
  // `sort` ổn định: cùng phần dư giữ thứ tự khóa.
  rem.sort((a, b) => b.r - a.r);
  for (let i = 0; i < abs - given; i++)
    base.set(rem[i]!.key, base.get(rem[i]!.key)! + 1);
  const sign = amount < 0 ? -1 : 1;
  return new Map([...base].map(([k, v]) => [k, sign * v]));
}
