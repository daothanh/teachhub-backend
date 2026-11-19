import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type Onboarding,
  onboardingSchema,
  type OnboardingStep,
  onboardingStepSchema,
  type PatchOnboardingStepRequest,
  patchOnboardingStepRequestSchema,
} from './onboarding.schemas.js';

// Hợp đồng Sprint 2 (S1-CT-02); thân hàm ở S2-BE-10. Trạng thái lưu ở `tenants.settings.onboarding`.
@ApiTags('onboarding')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('onboarding')
export class OnboardingController {
  @Get()
  @ApiOperation({
    summary: 'Trạng thái 5 bước onboarding (US-0.2)',
    description: 'Mở lại app giữa chừng thì `currentStep` là bước dở (AC3).',
  })
  @ApiOkResponse({ standardSchema: onboardingSchema })
  get(): Onboarding {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Patch('steps/:step')
  @ApiOperation({
    summary: 'Đánh dấu một bước đã xong hoặc bỏ qua (US-0.2 AC2)',
  })
  @ApiOkResponse({ standardSchema: onboardingSchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  patchStep(
    @Param('step', { schema: onboardingStepSchema }) _step: OnboardingStep,
    @Body({ schema: patchOnboardingStepRequestSchema })
    _body: PatchOnboardingStepRequest,
  ): Onboarding {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
