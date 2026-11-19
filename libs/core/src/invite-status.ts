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
