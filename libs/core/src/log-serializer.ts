/** Header được phép vào log; còn lại (referer, cookie, authorization…) bỏ hết. */
const LOGGED_HEADERS = ['user-agent', 'content-type', 'content-length'];

/**
 * Log request chỉ giữ method, đường dẫn (bỏ query string: `q` = tên học viên, SĐT…) và vài header an toàn. `referer`
 * có thể mang query của trang gọi nên không nằm trong whitelist. Nhận bản đã chuẩn hóa của pino-http.
 */
export const reqLogSerializer = (req: {
  url?: string;
  query?: unknown;
  headers?: Record<string, unknown>;
  [k: string]: unknown;
}) => {
  const { query: _query, headers, ...rest } = req;
  return {
    ...rest,
    url: req.url?.split('?')[0],
    headers: Object.fromEntries(
      LOGGED_HEADERS.filter((h) => headers?.[h] !== undefined).map((h) => [
        h,
        headers![h],
      ]),
    ),
  };
};
