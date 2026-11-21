import { createHash, timingSafeEqual } from 'node:crypto';
import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppException, type Env } from '@teachhub/core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION = 'adminPermission';
const digest = (s: string) => createHash('sha256').update(s).digest();
const header = (req: FastifyRequest, name: string): string =>
  String(req.headers[name] ?? '').trim();

/** Gắn quyền IAM mà route đòi; `AdminGuard` đối chiếu với header `x-admin-permissions`. */
export const RequiresAdminPermission = (permission: string) =>
  applyDecorators(SetMetadata(PERMISSION, permission));

/**
 * Xác thực BFF admin (Spec §5.2e). Ba header phải có đủ: `x-admin-secret` (so thời gian hằng, băm SHA-256; chưa cấu hình
 * `ADMIN_API_SECRET` → 401 như sai secret), `x-admin-user-id` (UUID của nhân sự IAM) → thiếu/sai: 401 `UNAUTHENTICATED`;
 * `x-admin-permissions` phải đúng URI quyền của route → khác: 403 `FORBIDDEN`. Route không khai quyền (quên decorator) bị từ chối.
 * Dùng với `@Public()` (không JWT người dùng).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const given = header(req, 'x-admin-secret');
    // Cả hai secret đều được so (không dừng sớm) để thời gian không lộ secret nào khớp.
    const secrets = [
      this.config.get('ADMIN_API_SECRET'),
      this.config.get('ADMIN_API_SECRET_PREVIOUS'),
    ];
    const secretOk = secrets
      .map((s) => !!s && !!given && timingSafeEqual(digest(given), digest(s)))
      .some(Boolean);
    if (!secretOk || !UUID.test(header(req, 'x-admin-user-id')))
      throw new AppException('UNAUTHENTICATED');
    const need = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!need || header(req, 'x-admin-permissions') !== need)
      throw new AppException('FORBIDDEN');
    return true;
  }
}
