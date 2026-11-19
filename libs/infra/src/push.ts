import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Env } from '@teachhub/core';

/** Một tin push data-only tới một token: `data` chỉ chứa chuỗi định danh (`notificationId`, `type`), không có nội dung hiển thị. */
export interface PushMessage {
  token: string;
  data: Record<string, string>;
  urgent: boolean;
}

export type PushResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; invalidToken: boolean };

/** Che token trong log: chỉ để đối chiếu, không dùng lại được. */
export const maskToken = (token: string): string =>
  token.length <= 8 ? '***' : `${token.slice(0, 4)}…${token.slice(-4)}`;

/** Cổng gửi push (FCM). Test dùng bản giả; thiếu cấu hình dùng bản tắt. Kết quả đúng thứ tự `messages`. */
export abstract class PushSender {
  abstract readonly enabled: boolean;
  abstract send(messages: PushMessage[]): Promise<PushResult[]>;
}

/** Chưa cấu hình FCM (local, CI): không gửi gì, mọi tin báo lỗi tạm thời không đáng thử lại. */
@Injectable()
export class DisabledPushSender extends PushSender {
  readonly enabled = false;

  send(messages: PushMessage[]): Promise<PushResult[]> {
    return Promise.resolve(
      messages.map(() => ({
        ok: false as const,
        error: 'push_disabled',
        invalidToken: false,
      })),
    );
  }
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** FCM qua `firebase-admin`. Token sai/đã gỡ cài đặt được báo `invalidToken` để worker xóa thiết bị. */
export class FirebasePushSender extends PushSender {
  readonly enabled = true;
  private readonly messaging;

  constructor(serviceAccountJson: string) {
    super();
    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert(JSON.parse(serviceAccountJson) as object),
      });
    this.messaging = getMessaging(app);
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (!messages.length) return [];
    const res = await this.messaging.sendEach(
      messages.map((m) => ({
        token: m.token,
        data: m.data,
        android: {
          priority: m.urgent ? ('high' as const) : ('normal' as const),
        },
        apns: {
          headers: {
            'apns-priority': m.urgent ? '10' : '5',
            'apns-push-type': 'background',
          },
          payload: { aps: { contentAvailable: true } },
        },
      })),
    );
    return res.responses.map((r) =>
      r.success
        ? { ok: true as const, messageId: r.messageId ?? '' }
        : {
            ok: false as const,
            // Chỉ mã lỗi, không chép message (có thể chứa token).
            error: r.error?.code ?? 'unknown',
            invalidToken: INVALID_TOKEN_CODES.has(r.error?.code ?? ''),
          },
    );
  }
}

/** Có `FCM_SERVICE_ACCOUNT_JSON` hợp lệ → FCM; thiếu hoặc hỏng → tắt kèm cảnh báo, không làm worker chết. */
export function createPushSender(config: ConfigService<Env, true>): PushSender {
  const log = new Logger('PushSender');
  const json = config.get('FCM_SERVICE_ACCOUNT_JSON', { infer: true });
  if (!json) {
    log.warn(
      'Thiếu FCM_SERVICE_ACCOUNT_JSON: tắt gửi push (thông báo vẫn vào hộp thư)',
    );
    return new DisabledPushSender();
  }
  try {
    return new FirebasePushSender(json);
  } catch (e) {
    log.warn(
      `FCM_SERVICE_ACCOUNT_JSON không dùng được, tắt gửi push: ${e instanceof Error ? e.name : 'lỗi'}`,
    );
    return new DisabledPushSender();
  }
}

@Module({
  providers: [
    {
      provide: PushSender,
      inject: [ConfigService],
      useFactory: createPushSender,
    },
  ],
  exports: [PushSender],
})
export class PushModule {}
