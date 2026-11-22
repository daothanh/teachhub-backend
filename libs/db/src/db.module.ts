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
type TimeoutKey =
  | 'DB_STATEMENT_TIMEOUT_MS'
  | 'DB_LOCK_TIMEOUT_MS'
  | 'DB_IDLE_IN_TX_TIMEOUT_MS'
  | 'DB_CONNECT_TIMEOUT_MS';

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
            // Mỗi tiến trình một bộ timeout: worker đọc biến tiền tố WORKER_ (cùng backend.env với api).
            const ms = (k: TimeoutKey) =>
              config.get(
                urlKey === 'WORKER_DATABASE_URL' ? `WORKER_${k}` : k,
                { infer: true },
              );
            return new pg.Pool({
              connectionString: url,
              max: 10,
              statement_timeout: ms('DB_STATEMENT_TIMEOUT_MS'),
              lock_timeout: ms('DB_LOCK_TIMEOUT_MS'),
              idle_in_transaction_session_timeout: ms('DB_IDLE_IN_TX_TIMEOUT_MS'),
              connectionTimeoutMillis: ms('DB_CONNECT_TIMEOUT_MS'),
            });
          },
        },
        {
          provide: DB,
          inject: [DB_POOL],
          useFactory: (pool: pg.Pool) =>
            // Cùng quy ước tên cột với drizzle.config.ts (camelCase trong TS → snake_case trong CSDL).
            drizzle(pool, { schema, casing: 'snake_case' }),
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
