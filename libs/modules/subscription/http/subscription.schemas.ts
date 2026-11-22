import { z } from 'zod';
import { vndSchema } from '@teachhub/core';

// Hợp đồng Sprint 7 (S6-FL-06, S6-CT-01): gói Free/Pro, dùng thử, chuyển khoản, webhook RevenueCat (T14, US-0.7, US-0.8).
// Thân hàm ở task backend `subscription`. Bảng `subscriptions`, `plans` đã có từ Sprint 2 (Spec §4.4).

const dateTime = z.iso.datetime({ offset: true });

export const planCodeSchema = z.enum(['free', 'pro']).meta({ id: 'PlanCode' });

export const subscriptionStatusSchema = z
  .enum(['free', 'trialing', 'active', 'expired'])
  .meta({
    id: 'SubscriptionStatus',
    description:
      '`free` = chưa từng nâng cấp; `trialing` = đang dùng thử Pro; `active` = Pro đã trả phí còn hạn; `expired` = hết dùng thử hoặc hết hạn Pro, về giới hạn Miễn phí (phần vượt chỉ đọc, US-0.8 AC4)',
  });

export const subscriptionSourceSchema = z
  .enum(['app_store', 'play_store', 'bank_transfer'])
  .meta({ id: 'SubscriptionSource' });

export const planFeatureSchema = z
  .object({
    key: z.string().meta({
      description:
        'Khóa feature flag theo Spec §4.4 (`plan_features` + `tenant_feature_overrides`), vd `compliance.form02`, `compliance.form03`, `revenue.export`, `reports.export`. Client chỉ đọc khóa mình biết, bỏ qua khóa lạ',
      example: 'revenue.export',
    }),
    enabled: z.boolean(),
  })
  .meta({ id: 'PlanFeature' });

const orderStatusSchema = z.enum(['pending', 'confirmed']).meta({
  id: 'SubscriptionOrderStatus',
  description:
    '`pending` = chờ quản trị TeachHub xác nhận đã nhận tiền; `confirmed` = đã xác nhận (đơn đã kích hoạt Pro, không còn hiện ở `pendingBankTransferOrder`)',
});

export const subscriptionBankTransferOrderSchema = z
  .object({
    id: z.uuid(),
    planCode: planCodeSchema,
    amount: vndSchema('VND, số tiền phải chuyển cho gói Pro một năm'),
    transferNote: z
      .string()
      .regex(/^[A-Z0-9 ]{1,25}$/)
      .meta({
        description:
          'Nội dung chuyển khoản, chỉ `[A-Z0-9 ]`, ≤ 25 ký tự (cùng quy tắc `transferNote` hóa đơn); quản trị đối chiếu theo nội dung này',
        example: 'TEACHHUB PRO CO LAN',
      }),
    payee: z
      .object({
        bankBin: z.string().regex(/^\d{6}$/),
        bankName: z.string().nullable(),
        accountNo: z.string(),
        accountName: z.string(),
      })
      .meta({
        description:
          'Tài khoản nhận tiền của TeachHub (cấu hình hệ thống), đủ để chép tay khi quét QR không được',
      }),
    qrPayload: z.string().max(512).meta({
      description:
        'Chuỗi VietQR sinh bằng `buildVietQrPayload`, đã chứa số tiền và nội dung; client chỉ vẽ mã QR (màn T14a)',
    }),
    status: orderStatusSchema,
    createdAt: dateTime,
  })
  .meta({
    id: 'SubscriptionBankTransferOrder',
    example: {
      id: '019d0a10-0001-7c40-8d01-000000000001',
      planCode: 'pro',
      amount: 250000,
      transferNote: 'TEACHHUB PRO CO LAN',
      payee: {
        bankBin: '970436',
        bankName: 'Vietcombank',
        accountNo: '0011004123456',
        accountName: 'CONG TY TEACHHUB',
      },
      qrPayload: '000201010212…6304ABCD',
      status: 'pending',
      createdAt: '2027-03-01T10:15:00+07:00',
    },
  });
export type SubscriptionBankTransferOrder = z.infer<
  typeof subscriptionBankTransferOrderSchema
>;

export const planUsageSchema = z
  .object({
    plan: z.object({
      code: planCodeSchema.meta({
        description:
          '`pro` khi `status` là `trialing` hoặc `active`; `free` với `free` và `expired`',
      }),
      status: subscriptionStatusSchema,
      source: subscriptionSourceSchema.nullable().meta({
        description:
          'Nơi thu phí; null khi `free`, `expired` chưa từng trả, hoặc `trialing`',
      }),
      currentPeriodEnd: dateTime.nullable().meta({
        description:
          'Hết hạn dùng thử (`trialing`) hoặc hết hạn Pro (`active`); null khi `free`. Dùng cho chip "Pro · còn N ngày" ở tab Thêm',
      }),
      daysLeft: z.int().min(0).nullable().meta({
        description:
          'Số ngày còn lại tới `currentPeriodEnd` (làm tròn lên, theo múi giờ tenant); null khi không có `currentPeriodEnd`',
      }),
      trialUsedAt: dateTime.nullable(),
      trialAvailable: z.boolean().meta({
        description:
          '`true` khi tenant chưa từng dùng thử (`trialUsedAt` null) và đang `free`; `false` thì màn T14 ẩn nút "Dùng thử 14 ngày" (biến thể "Đã dùng thử")',
      }),
    }),
    limits: z
      .object({
        maxActiveClasses: z.int().min(0).nullable(),
        maxActiveStudents: z.int().min(0).nullable(),
      })
      .meta({
        description:
          'Giới hạn của gói đang áp dụng (`plans.limits`); null = không giới hạn (Pro). Miễn phí: 3 lớp, 20 học sinh (US-0.7). Lớp đã lưu trữ và học sinh tạm nghỉ/đã nghỉ không tính (US-0.8 AC4)',
      }),
    usage: z.object({
      activeClasses: z.int().min(0),
      activeStudents: z.int().min(0),
    }),
    readOnly: z
      .object({
        classCount: z.int().min(0),
        studentCount: z.int().min(0),
      })
      .meta({
        description:
          'Số lớp và học sinh đang ở chế độ chỉ đọc vì vượt giới hạn sau khi hết dùng thử/hết hạn (US-0.8 AC4); 0 khi chưa vượt hoặc đang Pro. Chọn theo thời điểm tạo sớm nhất giữ lại, phần còn lại chỉ đọc',
      }),
    features: z.array(planFeatureSchema).meta({
      description:
        'Feature flag đang bật/tắt cho tenant (gói + ghi đè); thực thi ở backend, client chỉ dùng để hiện nhãn "Pro" và khóa (US-0.7 AC3, AC4). Tính năng khóa trả 402 `FEATURE_REQUIRES_PRO`',
    }),
    proPriceVnd: vndSchema(
      'Giá Pro một năm tính bằng VND cho chuyển khoản trên web; 0 = chưa công bố',
    )
      .nullable()
      .meta({
        description:
          'Giá hiển thị ở T14 cho kênh chuyển khoản; null khi chưa có (giá VNĐ chờ PO chốt). Giá App Store/Google Play lấy từ RevenueCat ở app, không qua API này',
      }),
    pendingBankTransferOrder: subscriptionBankTransferOrderSchema
      .nullable()
      .meta({
        description:
          'Đơn chuyển khoản đang chờ xác nhận (màn T14a "Chờ xác nhận"); null nếu không có',
      }),
  })
  .meta({
    id: 'PlanUsage',
    example: {
      plan: {
        code: 'pro',
        status: 'trialing',
        source: null,
        currentPeriodEnd: '2027-03-15T10:15:00+07:00',
        daysLeft: 14,
        trialUsedAt: '2027-03-01T10:15:00+07:00',
        trialAvailable: false,
      },
      limits: { maxActiveClasses: null, maxActiveStudents: null },
      usage: { activeClasses: 4, activeStudents: 23 },
      readOnly: { classCount: 0, studentCount: 0 },
      features: [
        { key: 'compliance.form02', enabled: true },
        { key: 'revenue.export', enabled: true },
      ],
      proPriceVnd: null,
      pendingBankTransferOrder: null,
    },
  });
export type PlanUsage = z.infer<typeof planUsageSchema>;

export const createBankTransferOrderRequestSchema = z
  .object({ planCode: z.literal('pro') })
  .meta({
    id: 'CreateSubscriptionBankTransferOrderRequest',
    example: { planCode: 'pro' },
  });
export type CreateBankTransferOrderRequest = z.infer<
  typeof createBankTransferOrderRequestSchema
>;

// ---- Webhook RevenueCat (US-0.8 AC2) ----

export const revenueCatEventSchema = z
  .object({
    id: z.string().min(1).max(200).meta({
      description:
        '`event.id` của RevenueCat: khóa idempotency, lưu ở `subscription_events`',
    }),
    type: z.string().min(1).max(60).meta({
      description:
        'Loại sự kiện RevenueCat. Cập nhật gói: `INITIAL_PURCHASE`, `RENEWAL`, `PRODUCT_CHANGE`, `UNCANCELLATION`, `NON_RENEWING_PURCHASE` → `active`; `EXPIRATION` và `CANCELLATION` có `cancel_reason = CUSTOMER_SUPPORT` (hoàn tiền) → `expired` ngay; `CANCELLATION` khác, `BILLING_ISSUE` chỉ ghi sự kiện, gói giữ tới hết kỳ. `TRANSFER`, loại khác và `TEST` → `ignored`',
      example: 'INITIAL_PURCHASE',
    }),
    app_user_id: z.string().min(1).max(200).meta({
      description:
        '`tenant_id` (UUID), app đặt khi đăng nhập RevenueCat; không PII (Spec §2.9). Không phải UUID tenant có thật → `ignored` (vẫn 200 để RevenueCat không thử lại)',
    }),
    product_id: z.string().max(200).optional(),
    original_transaction_id: z.string().max(200).optional().meta({
      description:
        'Giao dịch gốc của kho; nếu có, `EXPIRATION` chỉ hạ gói khi khớp với kỳ đang lưu',
    }),
    store: z.string().max(40).optional().meta({
      description:
        '`APP_STORE` → `source = app_store`, `PLAY_STORE` → `play_store`; kho khác → `ignored`',
    }),
    environment: z.enum(['SANDBOX', 'PRODUCTION']).optional().meta({
      description:
        'Môi trường production bỏ qua sự kiện `SANDBOX` (`ignored`); staging dùng project RevenueCat sandbox riêng (Spec §9.1)',
    }),
    expiration_at_ms: z.int().nullable().optional().meta({
      description: 'Mili giây epoch; thành `currentPeriodEnd`',
    }),
    event_timestamp_ms: z.int().optional().meta({
      description:
        'Mili giây epoch; sự kiện cũ hơn sự kiện đã xử lý của cùng tenant không ghi đè gói (`ignored`), vì RevenueCat có thể giao sai thứ tự',
    }),
    cancel_reason: z.string().max(40).optional().meta({
      description:
        'Lý do của `CANCELLATION`. `CUSTOMER_SUPPORT` = đã hoàn tiền → hạ gói ngay (cùng kiểm tra như `EXPIRATION`); lý do khác chỉ ghi sự kiện',
      example: 'UNSUBSCRIBE',
    }),
  })
  .loose()
  .meta({ id: 'RevenueCatEvent' });

export const revenueCatWebhookRequestSchema = z
  .object({
    api_version: z.string().max(20).optional(),
    event: revenueCatEventSchema,
  })
  .loose()
  .meta({
    id: 'RevenueCatWebhookRequest',
    description:
      'Thân webhook RevenueCat giữ nguyên tên trường snake_case của họ; trường không khai báo bị bỏ qua',
    example: {
      api_version: '1.0',
      event: {
        id: 'e2b1c7a0-4b3d-4f3e-9c2a-6f1d0a9b8c7d',
        type: 'INITIAL_PURCHASE',
        app_user_id: '019b2c10-0001-7a10-8a01-000000000001',
        product_id: 'teachhub_pro_yearly',
        store: 'APP_STORE',
        environment: 'PRODUCTION',
        expiration_at_ms: 1803000000000,
        event_timestamp_ms: 1771464000000,
      },
    },
  });
export type RevenueCatWebhookRequest = z.infer<
  typeof revenueCatWebhookRequestSchema
>;

export const revenueCatWebhookResultSchema = z
  .object({
    status: z.enum(['processed', 'duplicate', 'ignored']).meta({
      description:
        '`processed` = đã cập nhật `subscriptions`; `duplicate` = `event.id` đã xử lý, không làm gì; `ignored` = hợp lệ nhưng không áp dụng (loại/kho/môi trường/tenant lạ, sự kiện cũ)',
    }),
  })
  .meta({ id: 'RevenueCatWebhookResult', example: { status: 'processed' } });
export type RevenueCatWebhookResult = z.infer<
  typeof revenueCatWebhookResultSchema
>;
