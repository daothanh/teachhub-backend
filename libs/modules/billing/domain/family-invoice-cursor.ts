const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidCursorError extends Error {}

export const encodeInvoiceCursor = (issuedAt: string, id: string): string =>
  Buffer.from(`${issuedAt}|${id}`).toString('base64url');

/** Con trỏ chặt `<ISO µs>|<uuid>`: mã hóa lại phải ra đúng chuỗi gốc; sai → `InvalidCursorError` (service đổi thành 422). */
export function decodeInvoiceCursor(
  cursor: string | undefined,
): [string, string] | null {
  if (cursor === undefined) return null;
  const [at, id, extra] = Buffer.from(cursor, 'base64url')
    .toString()
    .split('|');
  const ok =
    at !== undefined &&
    id !== undefined &&
    extra === undefined &&
    AT.test(at) &&
    !Number.isNaN(Date.parse(at)) &&
    ID.test(id) &&
    encodeInvoiceCursor(at, id) === cursor;
  if (!ok) throw new InvalidCursorError();
  return [at, id];
}
