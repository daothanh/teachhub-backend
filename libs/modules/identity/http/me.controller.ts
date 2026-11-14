import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import {
  type ActiveMembershipRequest,
  activeMembershipRequestSchema,
  type AddRoleRequest,
  addRoleRequestSchema,
  type MembershipCreated,
  membershipCreatedSchema,
  type MembershipsResponse,
  membershipsResponseSchema,
} from './me.schemas.js';

// Hợp đồng Sprint 1 (S0-CT-01); thân hàm ở S1-BE-07.
@ApiTags('me')
@ApiBearerAuth('bearer')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
@Controller('me')
export class MeController {
  @Get('memberships')
  @ApiOperation({
    summary: 'Danh sách vai trò của user kèm nhãn hiển thị (US-0.10, US-0.11)',
  })
  @ApiOkResponse({ standardSchema: membershipsResponseSchema })
  memberships(): MembershipsResponse {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Put('active-membership')
  @HttpCode(204)
  @ApiOperation({ summary: 'Lưu vai trò dùng gần nhất (US-0.11 AC3)' })
  @ApiNoContentResponse()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  setActive(
    @Body({ schema: activeMembershipRequestSchema })
    _body: ActiveMembershipRequest,
  ): void {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post('roles')
  @ApiOperation({
    summary:
      'Thêm vai trò Phụ huynh/Học sinh rỗng, chưa liên kết học viên (US-0.10 AC3, US-0.12)',
    description:
      'Đã có vai trò đó → 200 với membership sẵn có (không tạo trùng).',
  })
  @ApiCreatedResponse({ standardSchema: membershipCreatedSchema })
  @ApiOkResponse({
    standardSchema: membershipCreatedSchema,
    description: 'Đã có vai trò này',
  })
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED')
  addRole(
    @Body({ schema: addRoleRequestSchema }) _body: AddRoleRequest,
  ): MembershipCreated {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
