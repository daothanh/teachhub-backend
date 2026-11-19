import { z } from 'zod';

/**
 * Chống SSRF: chỉ `https:`, không userinfo (host nằm ngay sau `https://`), không cổng (mặc định 443), host thuộc
 * allowlist dịch vụ push của trình duyệt. Server phải kiểm lại lúc gửi, không theo redirect.
 */
const endpoint = z
  .string()
  .max(2048)
  .regex(
    /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)\/[^\s@]*$/,
    'Endpoint push không hợp lệ.',
  )
  .meta({
    description:
      'URL của dịch vụ push do trình duyệt cấp, coi như bí mật, không bao giờ trả lại. Chỉ nhận `https` cổng 443 không userinfo, host `fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`',
    example: 'https://fcm.googleapis.com/fcm/send/mau-endpoint',
  });

/** Đúng dạng `PushSubscription.toJSON()` của trình duyệt. */
export const webPushSubscribeRequestSchema = z
  .object({
    endpoint,
    expirationTime: z.number().nullish().meta({
      description: 'Mili giây epoch hoặc null, như trình duyệt trả',
    }),
    keys: z.object({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(100),
    }),
  })
  .meta({
    id: 'WebPushSubscribeRequest',
    example: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/mau-endpoint',
      expirationTime: null,
      keys: { p256dh: 'BMau-p256dh-key', auth: 'mau-auth' },
    },
  });
export type WebPushSubscribeRequest = z.infer<
  typeof webPushSubscribeRequestSchema
>;

export const webPushUnsubscribeRequestSchema = z
  .object({ endpoint })
  .meta({ id: 'WebPushUnsubscribeRequest' });
export type WebPushUnsubscribeRequest = z.infer<
  typeof webPushUnsubscribeRequestSchema
>;
