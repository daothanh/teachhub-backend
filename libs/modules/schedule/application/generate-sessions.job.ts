import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { classes, tenants, TxService } from '@teachhub/db';
import { JobRuns } from '@teachhub/infra';
import { MAX_HORIZON_DAYS } from '../domain/session-generator.js';
import { localDate } from '../domain/zoned-time.js';
import { ScheduleService } from './schedule.service.js';

export const JOB_GENERATE_SESSIONS = 'schedule.generate-sessions';
const DAY = 86_400_000;
/** Mã lỗi Postgres (vd. 23505) của lỗi gốc, hoặc tên lỗi. */
const errorCode = (e: unknown): string => {
  const base = e instanceof Error ? (e.cause ?? e) : e;
  const code = (base as { code?: unknown }).code;
  return typeof code === 'string' ? code : ((base as Error)?.name ?? 'unknown');
};

/**
 * Job đêm nối dài buổi cuốn chiếu 8 tuần (S2-BE-09). Chạy bằng role worker (BYPASSRLS) nên mọi truy vấn lọc
 * `tenant_id` tường minh; "hôm nay" tính theo múi giờ từng tenant. Mỗi lớp một giao dịch, khóa dòng lớp như
 * `PUT schedule-rules`, nên chạy lại hay chạy chồng PUT không sinh trùng. Lớp lỗi không chặn lớp khác; có lỗi thì
 * job ghi `failed` và ném lại để BullMQ thử lại.
 */
@Injectable()
export class GenerateSessionsJob {
  private readonly log = new Logger(GenerateSessionsJob.name);

  constructor(
    private readonly tx: TxService,
    private readonly schedule: ScheduleService,
    private readonly runs: JobRuns,
  ) {}

  /** Trả số buổi đã sinh. */
  run(now = new Date()): Promise<number> {
    return this.runs.track(JOB_GENERATE_SESSIONS, async () => {
      const tenantRows = await this.tx.run({ userId: null }, (t) =>
        t
          .select({ id: tenants.id, tz: tenants.timezone })
          .from(tenants)
          .where(isNull(tenants.deletedAt)),
      );
      let generated = 0;
      let failed = 0;
      for (const tenant of tenantRows) {
        // Một tenant lỗi (múi giờ hỏng, truy vấn lỗi…) không chặn tenant khác.
        try {
          generated += await this.runTenant(tenant, now);
        } catch (e) {
          failed += 1;
          this.log.error(`tenant ${tenant.id}: ${errorCode(e)}`);
        }
      }
      if (failed) throw new Error(`${failed} tenant/lớp không sinh được buổi`);
      return generated;
    });
  }

  /** Sinh buổi cho các lớp cuốn chiếu của một tenant; lớp lỗi không chặn lớp khác (lỗi được tính vào `failed`). */
  private async runTenant(
    tenant: { id: string; tz: string },
    now: Date,
  ): Promise<number> {
    const today = localDate(now, tenant.tz);
    // Lớp không kỳ hạn, hoặc kỳ hạn dài quá mốc sinh tối đa của một lần (còn phần chưa sinh).
    const beyond = new Date(
      Date.parse(`${today}T00:00:00Z`) + (MAX_HORIZON_DAYS - 56) * DAY,
    )
      .toISOString()
      .slice(0, 10);
    const ids = await this.tx.run({ userId: null }, (t) =>
      t
        .select({ id: classes.id })
        .from(classes)
        .where(
          and(
            eq(classes.tenantId, tenant.id),
            eq(classes.status, 'active'),
            or(isNull(classes.endDate), gt(classes.endDate, beyond)),
          ),
        ),
    );
    let generated = 0;
    let failedClasses = 0;
    for (const { id } of ids) {
      try {
        generated += await this.tx.run({ userId: null }, async (t) => {
          const [cls] = await t
            .select()
            .from(classes)
            .where(
              and(
                eq(classes.tenantId, tenant.id),
                eq(classes.id, id),
                eq(classes.status, 'active'),
              ),
            )
            .for('update');
          if (!cls) return 0;
          const r = await this.schedule.reconcile(
            t,
            tenant.id,
            cls,
            now,
            tenant.tz,
          );
          return r.generated;
        });
      } catch (e) {
        failedClasses += 1;
        // Chỉ id lớp và mã lỗi: không log message (có thể chứa dữ liệu học viên).
        this.log.error(`lớp ${id}: ${errorCode(e)}`);
      }
    }
    if (failedClasses) throw new Error(`${failedClasses} lớp lỗi`);
    return generated;
  }
}
