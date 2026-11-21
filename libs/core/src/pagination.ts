import { z } from 'zod';

/** Query phân trang offset (Mục 5.5, G12): `page` từ 1, `pageSize` mặc định 20, tối đa 100. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** Đúng dạng `Paginated<T>` của web framework để `useTable` dùng trực tiếp. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function toLimitOffset({ page, pageSize }: PageQuery): {
  limit: number;
  offset: number;
} {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function paginated<T>(
  items: T[],
  total: number,
  { page, pageSize }: PageQuery,
): Paginated<T> {
  return { items, total, page, pageSize };
}

/** Query phân trang con trỏ (Mục 5.5): `cursor` mờ do server cấp, `limit` do endpoint giới hạn. */
export const cursorQuerySchema = (maxLimit: number, defaultLimit = 20) =>
  z.object({
    cursor: z.string().max(200).optional().meta({
      description: '`nextCursor` của trang trước; bỏ trống = trang đầu',
    }),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  });

/** Thân danh sách con trỏ (Mục 5.5): `{ items, nextCursor }`, `nextCursor = null` khi hết. */
export const cursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
