export type ReconcileKind =
  'revenue_total' | 'payment_ledger' | 'invoice_paid' | 'invoice_overpaid';

export interface ReconcileMismatch {
  kind: ReconcileKind;
  /** Số mục lệch (thanh toán/hóa đơn; 1 với loại cấp tenant). */
  count: number;
  /** Tổng chênh tuyệt đối, VND. */
  diffAmount: number;
  /** Tối đa `SAMPLE_IDS` id mẫu; không có PII. */
  sampleIds: string[];
}

export const SAMPLE_IDS = 20;

const KIND_LABEL: Record<ReconcileKind, string> = {
  revenue_total: 'Σ thanh toán ≠ Σ sổ doanh thu',
  payment_ledger: 'thanh toán lệch dòng sổ doanh thu',
  invoice_paid: 'đã thu trên hóa đơn ≠ Σ thanh toán',
  invoice_overpaid: 'trả thừa ≠ sổ học viên',
};

/** Nội dung cảnh báo một tenant; chỉ số liệu và id, không tên/sđt. */
export const formatReconcileAlert = (
  tenantId: string,
  mismatches: ReconcileMismatch[],
): string =>
  [
    `[TeachHub] Đối soát billing lệch, tenant ${tenantId}`,
    ...mismatches.map(
      (m) =>
        `- ${KIND_LABEL[m.kind]}: ${m.count} mục, chênh ${m.diffAmount} đ` +
        (m.sampleIds.length ? ` (mẫu: ${m.sampleIds.join(', ')})` : ''),
    ),
  ].join('\n');
