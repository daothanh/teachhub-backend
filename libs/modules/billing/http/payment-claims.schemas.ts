import { z } from 'zod';
import { MAX_VND, vndSchema } from '@teachhub/core';
import { paymentResultSchema } from './payments.schemas.js';

// Hợp đồng Sprint 8 (S7-CT-01): phụ huynh báo đã chuyển khoản kèm ảnh biên lai, giáo viên xác nhận hoặc "chưa nhận được" (US-7.7, P1).
// Bảng `payment_claims` (Spec §4.4) và thân hàm ở task backend `billing`. Tiền: số nguyên đồng.

const dateTime = z.iso.datetime({ offset: true });

export const paymentClaimStatusSchema = z
  .enum(['pending', 'confirmed', 'rejected'])
  .meta({
    id: 'PaymentClaimStatus',
    description:
      '`pending` = chờ giáo viên (hóa đơn `pending_confirmation`); `confirmed` = giáo viên xác nhận, đã sinh thanh toán `bank_transfer`; `rejected` = giáo viên bấm "Chưa nhận được", hóa đơn về trạng thái trước đó và nhắc nợ chạy lại. Client coi giá trị lạ như `pending`',
  });

export const createPaymentClaimRequestSchema = z
  .object({
    receiptFileId: z.uuid().meta({
      description:
        'Tệp biên lai: `purpose = receipt`, `entityId` = hóa đơn này, `status = ready`, do chính user này tải lên (US-7.7 AC1 "đính ảnh" bắt buộc). Sai điều kiện nào → 422 `VALIDATION_FAILED` ở `receiptFileId`',
    }),
    amount: z.int().min(1).max(MAX_VND).optional().meta({
      description:
        'VND phụ huynh nói đã chuyển; bỏ trống = `remainingAmount` của hóa đơn. Chỉ để giáo viên đối chiếu, giáo viên quyết số tiền ghi thu khi xác nhận',
      example: 1400000,
    }),
    note: z.string().trim().max(300).optional().meta({
      description: 'Lời nhắn, vd. "Chuyển lúc 9h sáng, ngân hàng ACB"',
    }),
  })
  .meta({
    id: 'CreatePaymentClaimRequest',
    example: {
      receiptFileId: '019c0b30-0001-7b30-8c01-000000000001',
      amount: 1400000,
    },
  });
export type CreatePaymentClaimRequest = z.infer<
  typeof createPaymentClaimRequestSchema
>;

const actorSchema = z.object({ id: z.uuid(), name: z.string() });

export const paymentClaimSchema = z
  .object({
    id: z.uuid(),
    invoiceId: z.uuid(),
    status: paymentClaimStatusSchema,
    amount: vndSchema('VND phụ huynh khai (hoặc `remainingAmount` lúc báo)'),
    note: z.string().nullable(),
    receiptFileId: z.uuid().meta({
      description:
        'Giáo viên xem ảnh bằng `GET /files/{receiptFileId}/download-url` (URL 10 phút)',
    }),
    claimedBy: actorSchema.meta({ description: 'Phụ huynh báo' }),
    createdAt: dateTime,
    resolvedAt: dateTime.nullable(),
    resolvedBy: actorSchema.nullable(),
    rejectReason: z.string().nullable().meta({
      description:
        'Lý do giáo viên ghi khi `rejected`; null với trạng thái khác',
    }),
    paymentId: z.uuid().nullable().meta({
      description:
        'Thanh toán sinh ra khi `confirmed`; null với trạng thái khác',
    }),
  })
  .meta({
    id: 'PaymentClaim',
    example: {
      id: '019c0c40-0001-7b30-8c01-000000000001',
      invoiceId: '019c0a10-0001-7b30-8c01-000000000001',
      status: 'pending',
      amount: 1400000,
      note: null,
      receiptFileId: '019c0b30-0001-7b30-8c01-000000000001',
      claimedBy: {
        id: '019b2c00-0001-7b30-8c01-000000000009',
        name: 'Nguyễn Văn Hải',
      },
      createdAt: '2027-01-05T09:12:00+07:00',
      resolvedAt: null,
      resolvedBy: null,
      rejectReason: null,
      paymentId: null,
    },
  });
export type PaymentClaim = z.infer<typeof paymentClaimSchema>;

export const paymentClaimListSchema = z
  .object({ items: z.array(paymentClaimSchema) })
  .meta({
    id: 'PaymentClaimList',
    description:
      'Mọi lần báo của hóa đơn, mới trước, gồm đã xác nhận và bị từ chối. Không phân trang: một hóa đơn có ít lần báo',
  });
export type PaymentClaimList = z.infer<typeof paymentClaimListSchema>;

export const resolvePaymentClaimRequestSchema = z
  .discriminatedUnion('decision', [
    z.object({
      decision: z.literal('confirm'),
      amount: z.int().min(1).max(MAX_VND).optional().meta({
        description:
          'VND ghi thu; bỏ trống = `amount` của lần báo. Xử lý như `POST /invoices/{id}/payments` với `method = bank_transfer` (US-7.4: thu một phần, trả thừa vào sổ học viên)',
      }),
      paidOn: z.iso.date().optional().meta({
        description:
          'Ngày thu; bỏ trống = hôm nay theo múi giờ tenant. Cùng ràng buộc với `RecordPaymentRequest.paidOn`',
      }),
    }),
    z.object({
      decision: z.literal('reject'),
      reason: z
        .string()
        .trim()
        .min(1, 'Vui lòng nhập lý do.')
        .max(300)
        .meta({ description: 'Bắt buộc; gửi kèm thông báo cho phụ huynh' }),
    }),
  ])
  .meta({
    id: 'ResolvePaymentClaimRequest',
    example: { decision: 'confirm', amount: 1400000 },
  });
export type ResolvePaymentClaimRequest = z.infer<
  typeof resolvePaymentClaimRequestSchema
>;

export const resolvePaymentClaimResultSchema = z
  .object({
    claim: paymentClaimSchema,
    result: paymentResultSchema.nullable().meta({
      description:
        'Kết quả ghi thu như `POST /invoices/{id}/payments` khi `confirm`; null khi `reject`',
    }),
  })
  .meta({ id: 'ResolvePaymentClaimResult' });
export type ResolvePaymentClaimResult = z.infer<
  typeof resolvePaymentClaimResultSchema
>;
