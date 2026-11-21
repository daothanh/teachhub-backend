import { describe, expect, it } from 'vitest';
import { formatReconcileAlert } from './reconcile-message.js';

describe('thông điệp cảnh báo đối soát', () => {
  it('liệt kê từng loại lệch kèm số tiền và id mẫu', () => {
    const text = formatReconcileAlert('t-1', [
      { kind: 'revenue_total', count: 1, diffAmount: 500, sampleIds: [] },
      { kind: 'invoice_paid', count: 2, diffAmount: 70, sampleIds: ['a', 'b'] },
    ]);
    expect(text).toBe(
      [
        '[TeachHub] Đối soát billing lệch, tenant t-1',
        '- Σ thanh toán ≠ Σ sổ doanh thu: 1 mục, chênh 500 đ',
        '- đã thu trên hóa đơn ≠ Σ thanh toán: 2 mục, chênh 70 đ (mẫu: a, b)',
      ].join('\n'),
    );
  });
});
