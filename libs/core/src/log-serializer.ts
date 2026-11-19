/**
 * Query string chứa dữ liệu tìm kiếm (`q` = tên học viên, SĐT…): log request chỉ giữ đường dẫn. Nhận bản đã
 * chuẩn hóa của pino-http (`url`, `query`).
 */
export const reqLogSerializer = (req: {
  url?: string;
  query?: unknown;
  [k: string]: unknown;
}) => {
  const { query: _query, ...rest } = req;
  return { ...rest, url: req.url?.split('?')[0] };
};
