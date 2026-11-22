/** Sự kiện outbox khi sinh cảnh báo ngưỡng thuế (US-9.5 AC3). Payload chỉ có id/năm/mốc: không số tiền, không PII. */
export const TAX_THRESHOLD_ALERT = 'tax_threshold_alert';

export interface TaxThresholdAlertPayload {
  alertId: string;
  fiscalYear: number;
  milestone: TaxMilestone;
}

export type TaxMilestone = '400m' | '800m';

/** Hai ngưỡng doanh thu năm (US-9.5 AC2) và mốc cảnh báo 80% của từng ngưỡng (Spec §4.4, NFR-12). */
export const TAX_THRESHOLDS = [
  { milestone: '400m', warnAmount: 400_000_000, thresholdAmount: 500_000_000 },
  {
    milestone: '800m',
    warnAmount: 800_000_000,
    thresholdAmount: 1_000_000_000,
  },
] as const;
export type TaxThresholdDef = (typeof TAX_THRESHOLDS)[number];

export type ThresholdStatus = 'below' | 'warning' | 'exceeded';

/** `warning` từ đúng mốc cảnh báo (≥ 80%), `exceeded` từ đúng ngưỡng (≥ 100%). */
export function thresholdStatus(
  cumulative: number,
  t: Pick<TaxThresholdDef, 'warnAmount' | 'thresholdAmount'>,
): ThresholdStatus {
  if (cumulative >= t.thresholdAmount) return 'exceeded';
  return cumulative >= t.warnAmount ? 'warning' : 'below';
}

/** Một chữ số thập phân, không chặn ở 100; 0 khi lũy kế âm. */
export function progressPercent(
  cumulative: number,
  thresholdAmount: number,
): number {
  return cumulative <= 0
    ? 0
    : Math.round((cumulative / thresholdAmount) * 1000) / 10;
}
