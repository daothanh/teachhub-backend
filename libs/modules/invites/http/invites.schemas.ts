import { z } from 'zod';

// ---- Phía giáo viên: POST /students/{id}/invites · GET /students/{id}/invites · revoke · resend ----

export const createInviteRequestSchema = z
  .object({
    guardianId: z.uuid().meta({
      description:
        'Phụ huynh (`Guardian.id`) của học viên được mời. Mời lại phụ huynh đã có lời mời còn hiệu lực thì lời mời cũ bị vô hiệu',
    }),
  })
  .meta({
    id: 'CreateInviteRequest',
    example: { guardianId: '019b2c4f-0002-7b30-8c01-000000000001' },
  });
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const inviteStatusSchema = z
  .enum(['pending', 'used', 'expired', 'revoked'])
  .meta({
    id: 'InviteStatus',
    description:
      'pending = còn hiệu lực, used = phụ huynh đã nhận, expired = quá 7 ngày, revoked = giáo viên thu hồi hoặc bị lời mời mới thay',
  });

/** Dạng đọc lại: không bao giờ có `token` hay `shortCode`. */
export const inviteSchema = z
  .object({
    id: z.uuid(),
    studentId: z.uuid(),
    guardianId: z.uuid(),
    status: inviteStatusSchema,
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    acceptedBy: z
      .object({
        displayName: z.string(),
        acceptedAt: z.iso.datetime({ offset: true }),
      })
      .nullable()
      .meta({
        description:
          'Người đã nhận lời mời (tên hiển thị của tài khoản) và lúc nhận; null nếu chưa dùng. Để giáo viên phát hiện nhận nhầm',
      }),
  })
  .meta({
    id: 'Invite',
    example: {
      id: '019b2c80-0001-7a10-8a01-000000000001',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      guardianId: '019b2c4f-0002-7b30-8c01-000000000001',
      status: 'pending',
      createdAt: '2026-12-14T09:00:00+07:00',
      expiresAt: '2026-12-21T09:00:00+07:00',
      acceptedBy: null,
    },
  });
export type Invite = z.infer<typeof inviteSchema>;

/** Chỉ trả đúng lúc tạo (hoặc gửi lại): server chỉ giữ băm của `token`. */
export const inviteCreatedSchema = inviteSchema
  .extend({
    token: z.string().min(32).max(64).meta({
      description:
        'Token 256-bit base64url. Chỉ xuất hiện trong phản hồi tạo/gửi lại; không bao giờ đọc lại được',
    }),
    shortCode: z.string().length(8).meta({
      description:
        'Mã ngắn 8 ký tự Crockford base32 (chữ hoa, không có `I L O U`), để phụ huynh nhập tay. Chỉ xuất hiện ở phản hồi này',
    }),
    shortCodeExpiresAt: z.iso.datetime({ offset: true }).meta({
      description:
        'Mã ngắn chỉ sống 48 giờ (ngắn hơn link 7 ngày vì dễ đoán hơn); hết hạn thì dùng link hoặc `resend`',
    }),
    url: z.url().max(300).meta({
      description:
        'Link chia sẻ `https://dayhoc.app/i#t=<token>`: token nằm ở fragment nên không vào log máy chủ, CDN hay header Referer; client sinh mã QR từ chính chuỗi này. Trang landing phải đặt `Referrer-Policy: no-referrer` và `Cache-Control: no-store`, đọc fragment rồi gọi `POST /invites/preview` bằng body',
    }),
  })
  .meta({
    id: 'InviteCreated',
    example: {
      id: '019b2c80-0001-7a10-8a01-000000000001',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      guardianId: '019b2c4f-0002-7b30-8c01-000000000001',
      status: 'pending',
      createdAt: '2026-12-14T09:00:00+07:00',
      expiresAt: '2026-12-21T09:00:00+07:00',
      acceptedBy: null,
      token: 'q3Zp8mT1xV0kLw5Hn2RcYb7JdFgSaE9uXoIiKtUeMhA',
      shortCode: '7K3QZ9XM',
      shortCodeExpiresAt: '2026-12-16T09:00:00+07:00',
      url: 'https://dayhoc.app/i#t=q3Zp8mT1xV0kLw5Hn2RcYb7JdFgSaE9uXoIiKtUeMhA',
    },
  });
export type InviteCreated = z.infer<typeof inviteCreatedSchema>;

export const inviteListSchema = z
  .object({
    items: z.array(inviteSchema).max(2).meta({
      description: 'Lời mời mới nhất của từng phụ huynh (tối đa 2)',
    }),
  })
  .meta({ id: 'InviteList' });
export type InviteList = z.infer<typeof inviteListSchema>;

// ---- Phía phụ huynh: preview · accept · redeem-code ----

/**
 * Token nằm ở body, không ở đường dẫn (tránh vào log URL). Chuỗi bất kỳ ≤ 128 ký tự, cố ý không kiểm định dạng:
 * token sai định dạng, sai giá trị, hết hạn, đã dùng đều trả cùng `410 INVITE_INVALID`, không phải 422.
 */
export const inviteTokenRequestSchema = z
  .object({ token: z.string().min(1).max(128) })
  .meta({
    id: 'InviteTokenRequest',
    example: { token: 'q3Zp8mT1xV0kLw5Hn2RcYb7JdFgSaE9uXoIiKtUeMhA' },
  });
export type InviteTokenRequest = z.infer<typeof inviteTokenRequestSchema>;

export const invitePreviewSchema = z
  .object({
    teacherName: z.string(),
    studentGivenName: z.string().meta({
      description:
        'Chỉ tên gọi của trẻ (tên cuối), không họ; họ tên đầy đủ chỉ trả sau khi nhận lời mời',
    }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: 'InvitePreview',
    description:
      'Chỉ tên giáo viên và tên gọi của con; không có họ, lớp, liên hệ hay id',
    example: {
      teacherName: 'Cô Lan',
      studentGivenName: 'Anh',
      expiresAt: '2026-12-21T09:00:00+07:00',
    },
  });
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const redeemCodeRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[0-9A-TV-Za-tv-z]{8}$/, 'Mã mời gồm 8 ký tự.')
      .meta({
        description:
          'Mã ngắn 8 ký tự. Không phân biệt hoa thường; server đổi `I`/`L` → `1`, `O` → `0` theo Crockford',
        example: '7K3QZ9XM',
      }),
  })
  .meta({ id: 'RedeemInviteCodeRequest' });
export type RedeemCodeRequest = z.infer<typeof redeemCodeRequestSchema>;

export const inviteAcceptedSchema = z
  .object({
    membershipId: z.uuid().meta({
      description:
        'Membership Phụ huynh (có sẵn hoặc vừa tạo) để app chuyển vai trò',
    }),
    studentId: z.uuid(),
    studentName: z.string(),
  })
  .meta({
    id: 'InviteAccepted',
    example: {
      membershipId: '019a8f3e-9b21-7f66-9d2e-3c4d5e6f7a81',
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      studentName: 'Nguyễn Minh Anh',
    },
  });
export type InviteAccepted = z.infer<typeof inviteAcceptedSchema>;
