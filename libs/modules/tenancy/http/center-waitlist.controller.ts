import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import {
  type CenterWaitlistEntry,
  centerWaitlistEntrySchema,
  type CreateCenterWaitlistRequest,
  createCenterWaitlistRequestSchema,
} from './onboarding.schemas.js';

// Hợp đồng Sprint 2 (S1-CT-02); thân hàm ở S2-BE-11. Mọi người dùng đã đăng nhập đều gọi được.
@ApiTags('center-waitlist')
@ApiBearerAuth('bearer')
@Controller('center-waitlist')
export class CenterWaitlistController {
  @Post()
  @ApiOperation({
    summary: 'Đăng ký sớm Chủ trung tâm (US-0.10 AC4)',
    description: 'Gửi lặp cùng `Idempotency-Key` chỉ tạo một bản ghi.',
  })
  @ApiCreatedResponse({ standardSchema: centerWaitlistEntrySchema })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'UNAUTHENTICATED', 'TOKEN_EXPIRED')
  create(
    @Body({ schema: createCenterWaitlistRequestSchema })
    _body: CreateCenterWaitlistRequest,
  ): CenterWaitlistEntry {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
