import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Ngữ cảnh của một request (Mục 4.5). `JwtAuthGuard` (Sprint 1) gán `request.ctx` sau khi xác minh token;
 * route công khai nhận `userId: null`. Truyền thẳng vào `txService.run(ctx, …)` để RLS có `app.user_id`.
 */
export interface RequestContext {
  requestId: string;
  userId: string | null;
  sessionId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: RequestContext;
  }
}

export function requestContextOf(req: FastifyRequest): RequestContext {
  return req.ctx ?? { requestId: req.id, userId: null, sessionId: null };
}

/** `handler(@Ctx() ctx: RequestContext)` */
export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext) =>
  requestContextOf(host.switchToHttp().getRequest<FastifyRequest>()),
);
