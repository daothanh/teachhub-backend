import { Body, Controller, Get, Param, Patch, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { OnboardingService } from '../application/onboarding.service.js';
import {
  type Onboarding,
  onboardingSchema,
  type OnboardingStep,
  onboardingStepSchema,
  type PatchOnboardingStepRequest,
  patchOnboardingStepRequestSchema,
} from './onboarding.schemas.js';

// Trạng thái lưu ở `tenants.settings.onboarding`.
@ApiTags('onboarding')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly idem: Idempotency,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Trạng thái 5 bước onboarding (US-0.2)',
    description: 'Mở lại app giữa chừng thì `currentStep` là bước dở (AC3).',
  })
  @ApiOkResponse({ standardSchema: onboardingSchema })
  get(@Ctx() ctx: RequestContext): Promise<Onboarding> {
    return this.onboarding.get(ctx.userId!, tenantOf(ctx));
  }

  @Patch('steps/:step')
  @ApiOperation({
    summary: 'Đánh dấu một bước đã xong hoặc bỏ qua (US-0.2 AC2)',
  })
  @ApiOkResponse({ standardSchema: onboardingSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  async patchStep(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('step', { schema: onboardingStepSchema }) step: OnboardingStep,
    @Body({ schema: patchOnboardingStepRequestSchema })
    body: PatchOnboardingStepRequest,
  ): Promise<Onboarding> {
    const tenantId = tenantOf(ctx);
    let firstTime = false;
    const view = await this.idem.run(req, reply, ctx, async (t) => {
      const r = await this.onboarding.setStep(t, tenantId, step, body.status);
      firstTime = r.firstTime;
      return { status: 200, body: r.view };
    });
    // Sau commit; phát lại từ Idempotency-Key không chạy hàm trên nên không phát lần hai.
    if (firstTime) this.onboarding.publish(tenantId, step, body.status);
    return view;
  }
}

function tenantOf(ctx: RequestContext): string {
  if (!ctx.tenantId) throw new AppException('FORBIDDEN');
  return ctx.tenantId;
}
