import { z } from 'zod';

const termsVersion = z.string().trim().min(1).max(40).meta({
  description:
    'Phiên bản văn bản điều khoản/chính sách người dùng vừa đọc (do server cấp qua `GET /consents/status` hoặc `details.termsVersion` của `CONSENT_REQUIRED`)',
  example: '2026-12-01',
});

/** MVP: chỉ phụ huynh và học sinh đồng ý ở app; giáo viên đồng ý khi đăng ký (Sprint 1). */
const consentRole = z.enum(['parent', 'student']);

export const createConsentRequestSchema = z
  .object({ role: consentRole, termsVersion })
  .meta({
    id: 'CreateConsentRequest',
    example: { role: 'parent', termsVersion: '2026-12-01' },
  });
export type CreateConsentRequest = z.infer<typeof createConsentRequestSchema>;

export const consentSchema = z
  .object({
    id: z.uuid(),
    role: consentRole,
    termsVersion,
    acceptedAt: z.iso.datetime({ offset: true }).meta({
      description: 'Giờ server lúc ghi, không nhận từ client',
    }),
  })
  .meta({
    id: 'Consent',
    example: {
      id: '019b2c90-0001-7a10-8a01-000000000001',
      role: 'parent',
      termsVersion: '2026-12-01',
      acceptedAt: '2026-12-15T10:30:00+07:00',
    },
  });
export type Consent = z.infer<typeof consentSchema>;

export const consentStatusQuerySchema = z.object({ role: consentRole });
export type ConsentStatusQuery = z.infer<typeof consentStatusQuerySchema>;

export const consentStatusSchema = z
  .object({
    role: consentRole,
    currentTermsVersion: termsVersion,
    accepted: z.boolean().meta({
      description:
        'true khi user đã đồng ý đúng `currentTermsVersion` cho vai trò này',
    }),
    acceptedAt: z.iso.datetime({ offset: true }).nullable(),
    acceptedTermsVersion: z.string().max(40).nullable(),
  })
  .meta({
    id: 'ConsentStatus',
    example: {
      role: 'parent',
      currentTermsVersion: '2026-12-01',
      accepted: false,
      acceptedAt: null,
      acceptedTermsVersion: null,
    },
  });
export type ConsentStatus = z.infer<typeof consentStatusSchema>;
