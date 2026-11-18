import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Ctx,
  type RequestContext,
  uuidv7,
} from '@teachhub/core';
import { memberships, tenants, TxService, users } from '@teachhub/db';
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

/** MVP chỉ trả 3 vai trò này (hợp đồng `roleSchema`); vai trò khác của Giai đoạn 2 bị lọc. */
const MVP_ROLES = ['tenant_owner', 'parent', 'student'] as const;
type MvpRole = (typeof MVP_ROLES)[number];

const label = (role: MvpRole, tenantName: string | null) =>
  role === 'tenant_owner'
    ? `Giáo viên · ${tenantName ?? ''}`.trim()
    : role === 'parent'
      ? 'Phụ huynh'
      : 'Học sinh';

/** Vai trò của user đang đăng nhập (S1-BE-07). RLS chỉ cho thấy membership của chính user. */
@ApiTags('me')
@ApiBearerAuth('bearer')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED')
@Controller('me')
export class MeController {
  constructor(private readonly tx: TxService) {}

  @Get('memberships')
  @ApiOperation({
    summary: 'Danh sách vai trò của user kèm nhãn hiển thị (US-0.10, US-0.11)',
  })
  @ApiOkResponse({ standardSchema: membershipsResponseSchema })
  memberships(@Ctx() ctx: RequestContext): Promise<MembershipsResponse> {
    const userId = ctx.userId!;
    return this.tx.run({ userId }, async (t) => {
      const rows = await t
        .select({
          id: memberships.id,
          role: memberships.role,
          tenantId: memberships.tenantId,
          studentId: memberships.studentId,
          tenantName: tenants.name,
        })
        .from(memberships)
        .leftJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
            inArray(memberships.role, [...MVP_ROLES]),
          ),
        )
        .orderBy(asc(memberships.createdAt));
      const [u] = await t
        .select({ last: users.lastMembershipId })
        .from(users)
        .where(eq(users.id, userId));
      const items = rows.map((r) => ({
        id: r.id,
        role: r.role as MvpRole,
        label: label(r.role as MvpRole, r.tenantName),
        tenantId: r.tenantId,
        studentId: r.studentId,
      }));
      // Vai trò gần nhất đã bị thu hồi → coi như chưa chọn.
      const last = u?.last ?? null;
      return {
        items,
        lastMembershipId: items.some((i) => i.id === last) ? last : null,
      };
    });
  }

  @Put('active-membership')
  @HttpCode(204)
  @ApiOperation({ summary: 'Lưu vai trò dùng gần nhất (US-0.11 AC3)' })
  @ApiNoContentResponse()
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  async setActive(
    @Ctx() ctx: RequestContext,
    @Body({ schema: activeMembershipRequestSchema })
    body: ActiveMembershipRequest,
  ): Promise<void> {
    const userId = ctx.userId!;
    const updated = await this.tx.run({ userId }, (t) =>
      t
        .update(users)
        .set({ lastMembershipId: body.membershipId })
        .where(
          and(
            eq(users.id, userId),
            // Chỉ vai trò đang hoạt động của chính mình (RLS ẩn vai trò người khác).
            sql`exists (select 1 from ${memberships} m where m.id = ${body.membershipId}
                         and m.user_id = ${userId} and m.status = 'active')`,
          ),
        )
        .returning({ id: users.id }),
    );
    if (updated.length === 0) throw new AppException('NOT_FOUND');
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
  async addRole(
    @Ctx() ctx: RequestContext,
    @Body({ schema: addRoleRequestSchema }) body: AddRoleRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MembershipCreated> {
    const userId = ctx.userId!;
    const result = await this.tx.run({ userId }, async (t) => {
      const [created] = await t
        .insert(memberships)
        .values({ id: uuidv7(), userId, role: body.role })
        .onConflictDoNothing()
        .returning({ id: memberships.id });
      if (created) {
        // `mv` trong token đổi → cache membership (S1-BE-07b) tự vô hiệu.
        await t
          .update(users)
          .set({ membershipsVersion: sql`${users.membershipsVersion} + 1` })
          .where(eq(users.id, userId));
        return { id: created.id, created: true };
      }
      const [existing] = await t
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.role, body.role),
            sql`${memberships.tenantId} is null and ${memberships.studentId} is null`,
          ),
        );
      return existing ? { ...existing, created: false } : undefined;
    });
    // Vai trò bị thu hồi chỉ người có quyền mới kích hoạt lại được.
    if (!result || ('status' in result && result.status !== 'active')) {
      throw new AppException('FORBIDDEN');
    }
    if (!result.created) void reply.status(200);
    return { membershipId: result.id };
  }
}
