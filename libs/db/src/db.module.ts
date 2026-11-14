import {
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Env } from '@teachhub/core';
import * as schema from './schema/index.js';
import { DB, DB_POOL } from './tokens.js';
import { TxService } from './tx.service.js';

type UrlKey = 'DATABASE_URL' | 'WORKER_DATABASE_URL';

@Module({})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  /** `api` dùng DATABASE_URL (teachhub_app), `worker` dùng WORKER_DATABASE_URL (teachhub_worker). */
  static register(urlKey: UrlKey = 'DATABASE_URL'): DynamicModule {
    return {
      module: DbModule,
      global: true,
      providers: [
        {
          provide: DB_POOL,
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) => {
            const url = config.get(urlKey, { infer: true });
            if (!url) throw new Error(`Thiếu biến môi trường ${urlKey}`);
            return new pg.Pool({ connectionString: url, max: 10 });
          },
        },
        {
          provide: DB,
          inject: [DB_POOL],
          useFactory: (pool: pg.Pool) => drizzle(pool, { schema }),
        },
        TxService,
      ],
      exports: [DB, DB_POOL, TxService],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
