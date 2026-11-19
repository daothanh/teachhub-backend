import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '@teachhub/core';
import { type Tx, TxService } from '@teachhub/db';
import {
  canSet,
  type OnboardingStatus,
  type OnboardingStepName,
  type StoredSteps,
  toView,
} from '../domain/onboarding.js';

type Row = { steps: StoredSteps | null };

/** Trạng thái onboarding nằm ở `tenants.settings.onboarding.steps` (ADR-TH-BE-001 §8). */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private readonly tx: TxService) {}

  async get(userId: string, tenantId: string) {
    const rows = await this.tx.run({ userId }, async (t) => {
      const r = await t.execute<Row>(
        sql`select settings #> '{onboarding,steps}' as steps from tenants where id = ${tenantId}`,
      );
      return r.rows;
    });
    // RLS ẩn tenant không thuộc user → 0 dòng.
    if (!rows[0]) throw new AppException('FORBIDDEN');
    return toView(rows[0].steps ?? undefined);
  }

  /** Ghi đè (idempotent) trạng thái một bước, trong giao dịch `t` do caller mở. */
  async setStep(
    t: Tx,
    tenantId: string,
    step: OnboardingStepName,
    status: Exclude<OnboardingStatus, 'pending'>,
  ) {
    if (!canSet(step, status)) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        status: ['Bước tạo lớp không thể bỏ qua.'],
      });
    }
    // Khóa dòng: hai PATCH đồng thời không ghi đè lẫn nhau, và đọc trạng thái cũ để biết có đổi không.
    const before = await t.execute<Row>(
      sql`select settings #> '{onboarding,steps}' as steps from tenants where id = ${tenantId} for update`,
    );
    if (!before.rows[0]) throw new AppException('FORBIDDEN');
    const previous = before.rows[0].steps?.[step];
    const after = await t.execute<Row>(
      sql`update tenants set settings = settings || jsonb_build_object('onboarding',
            coalesce(settings -> 'onboarding', '{}'::jsonb) || jsonb_build_object('steps',
              coalesce(settings #> '{onboarding,steps}', '{}'::jsonb) || jsonb_build_object(${step}::text, ${status}::text)))
          where id = ${tenantId}
          returning settings #> '{onboarding,steps}' as steps`,
    );
    if (previous !== status) this.emit(tenantId, step, status);
    return toView(after.rows[0]!.steps ?? undefined);
  }

  // shortcut: chưa có kênh analytics/outbox sự kiện; ghi log có cấu trúc (không PII), phát trong giao dịch nên
  // có thể lệch nếu commit lỗi. Nâng lên outbox khi S7 làm analytics.
  private emit(
    tenantId: string,
    step: OnboardingStepName,
    status: Exclude<OnboardingStatus, 'pending'>,
  ) {
    this.logger.log({
      event:
        status === 'done' ? 'onboarding_step_completed' : 'onboarding_skipped',
      tenantId,
      step,
    });
  }
}
