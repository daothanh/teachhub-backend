import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ApiErrors, AppException, requestContextOf } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { PlanService } from '../application/plan.service.js';

const FEATURE = 'requiredFeature';

/**
 * Chặn tính năng Pro ở backend (US-0.7 AC4, Spec §4.4): tenant không có cờ `feature` (theo gói, có tenant ghi đè) → 402
 * `FEATURE_REQUIRES_PRO` kèm `details.feature`. Phải chạy SAU `@RequiresRole` (cần `ctx.tenantId` do MembershipGuard gán);
 * guard cấp class chạy trước guard cấp method nên đặt `@RequiresRole` ở class hoặc ở dòng trên `@RequiresFeature`.
 * Module dùng guard phải import `PlanModule`.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tx: TxService,
    private readonly plans: PlanService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<string | undefined>(
      FEATURE,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;
    const ctx = requestContextOf(
      context.switchToHttp().getRequest<FastifyRequest>(),
    );
    // Không có tenant = quên `@RequiresRole` trước guard này: từ chối thay vì cho qua.
    if (!ctx.tenantId) throw new AppException('FORBIDDEN');
    const tenantId = ctx.tenantId;
    if (
      !(await this.tx.run(ctx, (t) =>
        this.plans.hasFeature(t, tenantId, feature),
      ))
    )
      throw new AppException('FEATURE_REQUIRES_PRO', { feature });
    return true;
  }
}

/** `@RequiresFeature('compliance.form02')` trên handler hoặc controller. */
export const RequiresFeature = (feature: string) =>
  applyDecorators(
    SetMetadata(FEATURE, feature),
    UseGuards(FeatureGuard),
    ApiErrors('FEATURE_REQUIRES_PRO'),
  );
