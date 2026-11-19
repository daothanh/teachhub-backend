import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
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
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrors,
  ApiIdempotencyKey,
  AppException,
  Ctx,
  type RequestContext,
  uuidv7,
} from '@teachhub/core';
import {
  idempotencyKeys,
  memberships,
  tenants,
  TxService,
  users,
} from '@teachhub/db';
import { Idempotency } from '@teachhub/infra';
import { OtpService, SessionService } from '@teachhub/modules/auth';
import { MembershipCache } from '../membership-cache.service.js';
import {
  type ActiveMembershipRequest,
  activeMembershipRequestSchema,
  type DeleteAccountRequest,
  deleteAccountRequestSchema,
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
  constructor(
    private readonly tx: TxService,
    private readonly idem: Idempotency,
    private readonly cache: MembershipCache,
    private readonly otp: OtpService,
    private readonly session: SessionService,
  ) {}

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
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: addRoleRequestSchema }) body: AddRoleRequest,
  ): Promise<MembershipCreated> {
    const userId = ctx.userId!;
    const result = await this.idem.run(req, reply, ctx, async (t) => {
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
        return { status: 201, body: { membershipId: created.id } };
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
      // Vai trò bị thu hồi chỉ người có quyền mới kích hoạt lại được.
      if (existing?.status !== 'active') throw new AppException('FORBIDDEN');
      return { status: 200, body: { membershipId: existing.id } };
    });
    // Vai trò mới phải có hiệu lực ngay với token đang dùng (S1-BE-07b).
    await this.cache.invalidate(ctx.userId!);
    return result;
  }

  // Hợp đồng Sprint 4 (S3-FL-12); S4-BE-09.
  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Xóa tài khoản (US-0.9, App Store 5.1.1(v))',
    description:
      'Xác nhận lại bằng OTP đã gửi với `purpose = delete_account`. OTP sai → 401 `OTP_INVALID`, sai nhiều lần → 429 `OTP_LOCKED` (cùng bộ đếm với đăng nhập). ' +
      'Theo Spec §4.8: thu hồi mọi refresh token và membership, xóa tệp và dữ liệu cá nhân, ẩn danh hóa (vd. `students.full_name` → "Học viên đã xóa #xxxx") trong 30 ngày; ' +
      'giữ `invoices`, `payments`, `revenue_ledger`, `audit_logs` tài chính 5 năm rồi xóa hẳn bằng job. Sau khi xóa, đăng nhập lại bằng email cũ tạo tài khoản mới, không thấy dữ liệu cũ. ' +
      'Thời hạn giữ chứng từ còn chờ kế toán và luật sư rà. ' +
      'Chủ không gian còn nhân sự khác → 409 `CONFLICT_STALE` (`details.reason = OWNER_HAS_STAFF`, phải chuyển quyền trước). Nhân sự duy nhất của không gian còn lớp đang hoạt động → 409 (`TENANT_HAS_ACTIVE_CLASSES`): lưu trữ hết lớp rồi xóa lại. ' +
      'Nhân sự duy nhất không còn lớp hoạt động: không gian được đánh dấu xóa và học viên, phụ huynh trong đó bị ẩn danh ngay. Access token cũ bị từ chối 401 sau khi xóa.',
  })
  @ApiNoContentResponse()
  @ApiIdempotencyKey()
  @ApiErrors('VALIDATION_FAILED', 'OTP_INVALID', 'OTP_LOCKED', 'CONFLICT_STALE')
  async deleteAccount(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: deleteAccountRequestSchema }) body: DeleteAccountRequest,
  ): Promise<void> {
    const userId = ctx.userId!;
    await this.idem.run(req, reply, ctx, async (t) => {
      const [u] = await t
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId));
      // Không có email thì không có hộp thư nhận OTP.
      if (!u?.email) throw new AppException('OTP_INVALID');

      // Khóa user + tenant và kiểm điều kiện chặn trước khi tiêu OTP: bị chặn thì mã còn dùng lại được.
      const check = async (checkOnly: boolean) =>
        (
          await t.execute<{ r: string | null }>(
            sql`select app_private.delete_account(${checkOnly}) as r`,
          )
        ).rows[0]!.r;
      const blocked = await check(true);
      if (blocked) {
        throw new AppException('CONFLICT_STALE', { reason: blocked });
      }

      // OTP đã tiêu ở Redis: giao dịch DB rollback sau đó thì người dùng phải xin mã mới.
      await this.otp.verify(u.email, body.otp, 'delete_account');
      // Khóa idempotency cũ giữ phản hồi (có thể chứa dữ liệu cá nhân); khóa của chính lệnh này được ghi sau.
      await t.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
      // Khóa giữ từ lần kiểm trên (cùng giao dịch) nên điều kiện không đổi giữa hai lần gọi.
      const again = await check(false);
      if (again) throw new AppException('CONFLICT_STALE', { reason: again });
      return { status: 204, body: undefined };
    });
    // Mọi token cũ mất vai trò ngay và bị guard từ chối 401 cho tới khi hết hạn.
    await this.cache.invalidate(userId);
    await this.session.markDeleted(userId);
  }
}
