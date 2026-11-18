import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppException, Public } from '@teachhub/core';
import { DB, type Database } from '@teachhub/db';
import { ObjectStorage, REDIS } from '@teachhub/infra';

/** Health cho Load Balancer và uptime (Mục 2.10). Nằm ngoài tiền tố /v1 và ngoài hợp đồng OpenAPI. */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [db, redis, s3] = await Promise.allSettled([
      this.db.execute(sql`select 1`),
      this.redis.ping(),
      this.storage.ping(),
    ]);
    const checks = {
      db: db.status === 'fulfilled',
      redis: redis.status === 'fulfilled',
      s3: s3.status === 'fulfilled',
    };
    if (!checks.db || !checks.redis || !checks.s3)
      throw new AppException('SERVICE_UNAVAILABLE', checks);
    return { status: 'ok', checks };
  }
}
