import { and, desc, eq, inArray } from 'drizzle-orm';
import type { LatestInviteRow } from '@teachhub/core/invite-status.js'; // không qua index: tránh nạp CoreModule khi import lib db
import { invites } from './schema/index.js';
import type { Tx } from './tx.service.js';

/** Lời mời mới nhất (mọi trạng thái) của từng phụ huynh trong tenant. Không đọc token/mã (chỉ băm, và cũng không chọn). */
export async function latestInvitesByGuardian(
  tx: Tx,
  tenantId: string,
  guardianIds: string[],
): Promise<Map<string, LatestInviteRow>> {
  if (!guardianIds.length) return new Map();
  const rows = await tx
    .selectDistinctOn([invites.guardianId], {
      guardianId: invites.guardianId,
      id: invites.id,
      status: invites.status,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(
      and(
        eq(invites.tenantId, tenantId),
        inArray(invites.guardianId, guardianIds),
      ),
    )
    .orderBy(invites.guardianId, desc(invites.createdAt), desc(invites.id));
  return new Map(
    rows.map((r) => [
      r.guardianId,
      {
        id: r.id,
        status: r.status as LatestInviteRow['status'],
        expiresAt: r.expiresAt,
      },
    ]),
  );
}
