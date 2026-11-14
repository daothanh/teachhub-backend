import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const REQUEST_ID = /^[\w-]{1,64}$/;

/** Dùng `x-request-id` của client nếu hợp lệ (chống chèn log), không thì sinh UUID. */
export function genRequestId(req: Pick<IncomingMessage, 'headers'>): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming)
    ? incoming
    : randomUUID();
}
