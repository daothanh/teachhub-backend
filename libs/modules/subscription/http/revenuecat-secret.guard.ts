import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { AppException, type Env } from '@teachhub/core';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Webhook RevenueCat (Spec §7.1): header `Authorization` phải bằng REVENUECAT_WEBHOOK_SECRET, so sánh thời gian hằng
 * (băm SHA-256 để cùng độ dài). Chưa cấu hình bí mật → 401 như sai bí mật (fail closed, không lộ trạng thái cấu hình); sai/thiếu → 401.
 */
@Injectable()
export class RevenueCatSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get('REVENUECAT_WEBHOOK_SECRET');
    const given = context.switchToHttp().getRequest<FastifyRequest>()
      .headers.authorization;
    if (
      !secret ||
      typeof given !== 'string' ||
      !timingSafeEqual(digest(given), digest(secret))
    )
      throw new AppException('UNAUTHENTICATED');
    return true;
  }
}
