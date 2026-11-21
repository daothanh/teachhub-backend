import { z } from 'zod';

/** Trần mọi khoản tiền trong hợp đồng (100 tỷ đồng): nằm trong số nguyên an toàn của JS và `bigint` của CSDL. */
export const MAX_VND = 100_000_000_000;

/**
 * Quy ước tiền (Spec §5.1, AGENTS.md): số nguyên đồng (VND), không float, không đơn vị nghìn.
 * Tên trường thống nhất: `<ý nghĩa>Amount` (`feeAmount`, `totalAmount`); riêng dòng hóa đơn và dòng điều chỉnh dùng `amount`.
 * Hiển thị `150.000 đ` là việc của client. Phần mô tả của từng schema ghi rõ khoản đó có dấu hay không.
 */
export const vndSchema = (description: string) =>
  z.int().min(0).max(MAX_VND).meta({ description });

/** Khoản có dấu (dòng hóa đơn, điều chỉnh): âm = giảm trừ. */
export const signedVndSchema = (description: string) =>
  z.int().min(-MAX_VND).max(MAX_VND).meta({ description });
