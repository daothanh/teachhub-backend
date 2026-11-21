import type { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import type { TxService } from '@teachhub/db';
import type { Mailer } from '@teachhub/infra';

/** Dòng `queued` bỏ dở lâu hơn mức này coi như worker trước đã chết, được nhận lại. */
const STALE_CLAIM_MS = 2 * 60_000;

/**
 * Gửi email của một thông báo, idempotent theo `(notification, channel)` (dùng chung cho các notifier tiền).
 * `true` = xong (đã gửi, hoặc người khác đang gửi); `false` = lỗi gửi, cần thử lại.
 */
export async function deliverEmail(
  deps: { tx: TxService; mailer: Mailer; log: Logger },
  notificationId: string,
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  const { tx: txs, mailer, log } = deps;
  const claimed = await txs.run({ userId: null }, async (tx) => {
    const ins = await tx.execute(sql`
      insert into notification_deliveries (id, notification_id, channel)
      values (${uuidv7()}, ${notificationId}, 'email') on conflict do nothing returning id`);
    if (ins.rows.length) return true;
    const re = await tx.execute(sql`
      update notification_deliveries set status = 'queued', error = null, created_at = now()
      where notification_id = ${notificationId} and channel = 'email'
        and (status = 'failed' or (status = 'queued' and created_at < now() - ${STALE_CLAIM_MS} * interval '1 millisecond'))
      returning id`);
    return re.rows.length > 0;
  });
  if (!claimed) return true;
  let error: string | null = null;
  try {
    await mailer.send({ to, subject, text });
  } catch (e) {
    error = e instanceof Error ? e.name : 'send_threw';
    log.error(`gửi email ${notificationId} lỗi: ${error}`);
  }
  await txs.run({ userId: null }, (tx) =>
    tx.execute(sql`
      update notification_deliveries set status = ${error ? 'failed' : 'sent'}, error = ${error},
        sent_at = ${error ? null : sql`now()`}
      where notification_id = ${notificationId} and channel = 'email' and status = 'queued'`),
  );
  return !error;
}
