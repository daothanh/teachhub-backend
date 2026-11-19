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
