import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppException } from '@teachhub/core';
import { DB, type Database } from '@teachhub/db';
import { REDIS } from '@teachhub/infra';

/** Health cho Load Balancer và uptime (Mục 2.10). Nằm ngoài tiền tố /v1. */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // shortcut: chưa kiểm R2, thêm khi có module files (Sprint 2).
  @Get('ready')
  async ready() {
    const [db, redis] = await Promise.allSettled([
      this.db.execute(sql`select 1`),
      this.redis.ping(),
    ]);
    const checks = {
      db: db.status === 'fulfilled',
      redis: redis.status === 'fulfilled',
    };
    if (!checks.db || !checks.redis)
      throw new AppException('SERVICE_UNAVAILABLE', checks);
    return { status: 'ok', checks };
  }
}
