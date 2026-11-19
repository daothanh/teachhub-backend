import { z } from 'zod';

const endpoint = z.url().max(2048).meta({
  description:
    'URL của dịch vụ push do trình duyệt cấp; coi như bí mật, không bao giờ trả lại',
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
