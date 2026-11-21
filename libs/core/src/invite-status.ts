import { z } from 'zod';

/** Trạng thái mời của một phụ huynh (US-1.6 AC4), dùng chung cho `Guardian` và roster. */
export const guardianInviteStatusSchema = z
  .enum(['not_invited', 'invited', 'activated', 'expired'])
  .meta({
    id: 'GuardianInviteStatus',
    description:
      'not_invited = chưa mời hoặc đã thu hồi, invited = lời mời còn hạn, activated = phụ huynh đã nhận lời mời, expired = lời mời hết hạn (hiện nút "Gửi lại link")',
  });
export type GuardianInviteStatus = z.infer<typeof guardianInviteStatusSchema>;

/** Lời mời mới nhất của phụ huynh, để client gọi `resend`/`revoke` mà không cần `GET /students/{id}/invites`. */
export const latestInviteSchema = z
  .object({ id: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) })
  .nullable()
  .meta({
    id: 'LatestInvite',
    description:
      'Lời mời mới nhất (kể cả hết hạn); null nếu chưa mời. Không có token hay mã',
  });

export interface LatestInviteRow {
  id: string;
  status: 'pending' | 'used' | 'revoked';
  expiresAt: Date;
}

/**
 * Trạng thái mời của một phụ huynh: đã gắn tài khoản (`userId`) = activated; còn lại theo lời mời mới nhất:
 * pending còn hạn = invited, pending quá hạn = expired, used = activated, revoked hoặc chưa mời = not_invited.
 */
export function guardianInviteStatus(
  g: { userId: string | null },
  latest: LatestInviteRow | undefined,
  now: Date,
): GuardianInviteStatus {
  if (g.userId || latest?.status === 'used') return 'activated';
  if (latest?.status === 'pending') {
    return latest.expiresAt > now ? 'invited' : 'expired';
  }
  return 'not_invited';
}

const RANK: GuardianInviteStatus[] = [
  'activated',
  'invited',
  'expired',
  'not_invited',
];

/** Gộp theo học viên: activated > invited > expired > not_invited. */
export function mergeInviteStatus(
  statuses: GuardianInviteStatus[],
): GuardianInviteStatus {
  return RANK.find((s) => statuses.includes(s)) ?? 'not_invited';
}

/** Dạng trả về của `latestInvite` trong Student/roster; null nếu chưa mời. Dùng chung để không lặp khối map. */
export function toLatestInvite(
  latest: Pick<LatestInviteRow, 'id' | 'expiresAt'> | undefined,
): { id: string; expiresAt: string } | null {
  return latest
    ? { id: latest.id, expiresAt: latest.expiresAt.toISOString() }
    : null;
}
