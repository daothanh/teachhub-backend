import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppException, IS_PUBLIC } from '@teachhub/core';
import { JwtKeysService } from './jwt-keys.service.js';

/**
 * Guard toàn cục (§4.5 lớp 1): mọi route cần `Authorization: Bearer <access token>`, trừ route `@Public()`.
 * Gán `request.ctx` để handler truyền vào `TxService.run` (RLS có `app.user_id`).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AppException('UNAUTHENTICATED');
    }
    const claims = await this.jwt.verify(token);
    req.ctx = {
      requestId: req.id,
      userId: claims.userId,
      sessionId: claims.sessionId,
    };
    return true;
  }
}
