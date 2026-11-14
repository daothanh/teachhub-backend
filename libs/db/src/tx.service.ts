import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';
import { DB } from './tokens.js';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TxContext {
  /** null = chưa đăng nhập: RLS trả 0 dòng (Mục 4.5 R2). */
  userId: string | null;
}

/**
 * Mọi lệnh ghi chạy trong `TxService.run`: BEGIN → `set_config('app.user_id', …, true)` → fn → COMMIT.
 * `true` = LOCAL, chỉ sống trong giao dịch nên an toàn với PgBouncer transaction mode.
 */
@Injectable()
export class TxService {
  constructor(@Inject(DB) private readonly db: Database) {}

  run<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true)`,
      );
      return fn(tx);
    });
  }
}
