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
import { AppException, requestContextOf } from '@teachhub/core';
import { MembershipCache } from './membership-cache.service.js';

export type Role =
  | 'tenant_owner'
  | 'teacher'
  | 'accountant'
  | 'branch_manager'
  | 'parent'
  | 'student';

const ROLES = 'requiredRoles';

/**
 * Lớp 1 phân quyền (§4.5): user phải có một vai trò đang hoạt động trong `roles`, không thì 403.
 * Vai trò gắn tenant → `ctx.tenantId` là tenant đó (MVP: mỗi giáo viên một tenant).
 * shortcut: nhiều tenant cùng vai trò → lấy cái tạo trước; Giai đoạn 2 (trung tâm) chọn theo header/route.
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cache: MembershipCache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const ctx = requestContextOf(req);
    if (!ctx.userId) throw new AppException('UNAUTHENTICATED');
    const m = (await this.cache.active(ctx)).find((x) =>
      roles.includes(x.role as Role),
    );
    if (!m) throw new AppException('FORBIDDEN');
    req.ctx = { ...ctx, tenantId: m.tenantId };
    return true;
  }
}

/** `@RequiresRole('tenant_owner')` trên handler hoặc controller. */
export const RequiresRole = (...roles: Role[]) =>
  applyDecorators(SetMetadata(ROLES, roles), UseGuards(MembershipGuard));
