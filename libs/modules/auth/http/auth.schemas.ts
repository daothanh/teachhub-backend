import { z } from 'zod';

// Trường token/SSO dùng snake_case vì `tasco_auth` (DioAuthRepository) cố định như vậy (G1);
// mọi trường khác camelCase (Mục 5.1). Đây là quy ước duy nhất cho hợp đồng TeachHub.

const email = z.email().max(254).meta({ example: 'co.lan@example.com' });

export const otpSendRequestSchema = z.object({
  email,
  purpose: z.enum(['login', 'delete_account']).default('login').meta({
    description:
      'Mục đích mã. `delete_account` (S4-BE-09): mã chỉ dùng được cho `DELETE /me`, mã `login` không xóa được tài khoản và ngược lại',
  }),
});
export type OtpSendRequest = z.infer<typeof otpSendRequestSchema>;

export const loginRequestSchema = z.object({
  method: z.literal('email_otp'),
  email,
  code: z
    .string()
    .regex(/^\d{6}$/)
    .meta({ example: '482913' }),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const googleSsoRequestSchema = z.object({
  id_token: z
    .string()
    .min(1)
    .meta({ description: 'id_token do Google Sign-In trả về' }),
});
export type GoogleSsoRequest = z.infer<typeof googleSsoRequestSchema>;

export const appleSsoRequestSchema = z.object({
  id_token: z
    .string()
    .min(1)
    .max(4096)
    .meta({ description: 'identityToken do Sign in with Apple trả về' }),
  nonce: z.string().min(1).max(256).meta({
    description:
      'Nonce thô; client gửi SHA-256 hex của nó lên Apple. Server băm lại nonce thô và so với claim `nonce`',
  }),
  fullName: z.string().trim().max(120).optional().meta({
    description:
      'Apple chỉ gửi tên cho client ở lần đăng nhập đầu; client chuyển tiếp để lưu tên hiển thị',
  }),
});
export type AppleSsoRequest = z.infer<typeof appleSsoRequestSchema>;

export const refreshRequestSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const userSchema = z
  .object({
    id: z.uuid(),
    email,
    displayName: z.string().nullable(),
    /** Dạng `role:<vai trò>` mà `tasco_auth` đọc để dựng PermissionGuard. */
    permissions: z.array(z.string()).meta({ example: ['role:tenant_owner'] }),
  })
  .meta({
    id: 'User',
    example: {
      id: '019a8f3e-7c1b-7d2a-9b3e-5f6a7b8c9d0e',
      email: 'co.lan@example.com',
      displayName: 'Cô Lan',
      permissions: ['role:tenant_owner'],
    },
  });
export type User = z.infer<typeof userSchema>;

const tokens = {
  access_token: z.string().meta({
    description: 'JWT ES256, sống 15 phút',
    // Ví dụ chỉ ASCII: header Authorization không nhận ký tự ngoài ASCII (mock Prism trả nguyên văn).
    example:
      'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Im1vY2sifQ.eyJzdWIiOiIwMTlhOGYzZS03YzFiLTdkMmEtOWIzZS01ZjZhN2I4YzlkMGUiLCJzaWQiOiJtb2NrLXNlc3Npb24iLCJpYXQiOjE3OTQ5NjAwMDAsImV4cCI6NDEwMjQ0NDgwMH0.bW9jay1zaWduYXR1cmU',
  }),
  refresh_token: z.string().meta({
    description: 'Xoay vòng mỗi lần làm mới',
    example: 'rt_mock_9Qm2xYzT4w',
  }),
  expires_in: z
    .int()
    .meta({ description: 'Số giây access_token còn hiệu lực', example: 900 }),
};

export const loginResponseSchema = z.object({ ...tokens, user: userSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshResponseSchema = z.object(tokens);
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;
