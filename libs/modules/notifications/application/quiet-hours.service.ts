import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { tenants, type Tx, writeAudit } from '@teachhub/db';
import { parseQuietWindow } from '../domain/quiet-hours.js';
import type { QuietHours } from '../http/quiet-hours.schemas.js';

/** Giờ yên lặng của tenant (US-6.5), lưu ở `tenants.settings.quietHours`; chưa chỉnh thì mặc định 21:30–07:00. */
@Injectable()
export class QuietHoursService {
  async get(tx: Tx, tenantId: string): Promise<QuietHours> {
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return parseQuietWindow(t?.settings);
  }

  async put(tx: Tx, tenantId: string, next: QuietHours): Promise<QuietHours> {
    const before = await this.get(tx, tenantId);
    await tx
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{quietHours}', ${JSON.stringify(next)}::jsonb)`,
      })
      .where(eq(tenants.id, tenantId));
    await writeAudit(tx, {
      tenantId,
      entity: 'quiet_hours',
      entityId: tenantId,
      action: 'update',
      before,
      after: next,
    });
    return next;
  }
}
