import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TxService } from '@teachhub/db';
import { JobRuns } from '@teachhub/infra';
import { TaxThresholdService } from './tax-threshold.service.js';

export const JOB_COMPLIANCE_TAX_THRESHOLD = 'compliance.tax-threshold';

/**
 * Job hằng ngày (08:00 giờ VN, trong khung giờ yên lặng cho push): với mỗi tenant có dòng sổ doanh thu của năm hiện tại
 * (theo múi giờ tenant) sinh cảnh báo 80% còn thiếu. Chạy bằng role worker (BYPASSRLS), lọc `tenant_id` tường minh; mỗi tenant
 * một giao dịch (alert + outbox cùng commit), lỗi một tenant không chặn tenant khác nhưng làm job ném lỗi để BullMQ thử lại.
 */
@Injectable()
export class TaxThresholdJob {
  private readonly log = new Logger(TaxThresholdJob.name);

  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
    private readonly thresholds: TaxThresholdService,
  ) {}

  /** Trả số cảnh báo mới sinh. */
  run(): Promise<number> {
    return this.runs.track(JOB_COMPLIANCE_TAX_THRESHOLD, async () => {
      const tenants = await this.tx.run(
        { userId: null },
        async (t) =>
          (
            await t.execute<{ id: string; year: number }>(sql`
            select t.id, extract(year from now() at time zone t.timezone)::int as year from tenants t
             where t.deleted_at is null and exists (
               select 1 from revenue_ledger r
                where r.tenant_id = t.id and r.fiscal_year = extract(year from now() at time zone t.timezone)::int)`)
          ).rows,
      );
      let created = 0;
      let failed = 0;
      for (const tenant of tenants) {
        try {
          created += await this.tx.run({ userId: null }, (t) =>
            this.thresholds.evaluate(t, tenant.id, tenant.year),
          );
        } catch (e) {
          failed += 1;
          this.log.error(
            `tenant ${tenant.id}: ${e instanceof Error ? e.name : 'lỗi'}`,
          );
        }
      }
      if (failed)
        throw new Error(`${failed} tenant không kiểm được ngưỡng thuế`);
      return created;
    });
  }
}
