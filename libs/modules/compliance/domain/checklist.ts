export const ITEM_KEYS = [
  'business_registration',
  'registration_number',
  'public_disclosure',
  'school_declaration',
] as const;
export type ItemKey = (typeof ITEM_KEYS)[number];
export type ItemStatus = 'todo' | 'done' | 'not_applicable';

interface ItemDef {
  title: string;
  description: string;
  /** Trạng thái do hệ thống suy ra, PATCH bị từ chối. */
  auto: boolean;
  /** Bài thư viện quy định dự kiến; chỉ trả ra khi bài đó đã phát hành. Admin đặt slug này khi soạn bài. */
  articleSlug: string;
}

// Chỉ mô tả việc cần làm, không khuyến nghị pháp lý cụ thể; nội dung nghĩa vụ nằm ở bài thư viện đã duyệt (US-9.6 AC3).
export const ITEM_DEFS: Record<ItemKey, ItemDef> = {
  business_registration: {
    title: 'Đăng ký hộ kinh doanh',
    description:
      'Đánh dấu khi bạn đã đăng ký hộ kinh doanh cho hoạt động dạy thêm.',
    auto: false,
    articleSlug: 'dang-ky-ho-kinh-doanh',
  },
  registration_number: {
    title: 'Lưu số giấy chứng nhận',
    description: 'Nhập số giấy chứng nhận đăng ký hộ kinh doanh để lưu lại.',
    auto: false,
    articleSlug: 'dang-ky-ho-kinh-doanh',
  },
  public_disclosure: {
    title: 'Công khai thông tin dạy thêm (Mẫu 02)',
    description:
      'Tự hoàn thành khi bạn bật công khai bảng thông tin các lớp đang dạy.',
    auto: true,
    articleSlug: 'cong-khai-mau-02',
  },
  school_declaration: {
    title: 'Khai báo trường chính khóa',
    description:
      'Tự hoàn thành khi bạn khai trường và lớp chính khóa đang dạy, hoặc khai không dạy ở trường.',
    auto: true,
    articleSlug: 'khai-bao-truong-chinh-khoa',
  },
};

/** Slug bài thư viện liên kết với cảnh báo ngưỡng thuế (US-9.5 AC3); trả ra khi bài đã phát hành. */
export const TAX_ARTICLE_SLUG = {
  '400m': 'nguong-doanh-thu-500-trieu',
  '800m': 'nguong-doanh-thu-1-ty',
} as const;

export interface StoredItem {
  status: ItemStatus;
  data: { registrationNo?: string } | null;
  completedAt: string | null;
}

export interface ChecklistItemView {
  itemKey: ItemKey;
  title: string;
  description: string;
  status: ItemStatus;
  auto: boolean;
  data: { registrationNo?: string } | null;
  legalArticleSlug: string | null;
  completedAt: string | null;
}

export interface ChecklistView {
  items: ChecklistItemView[];
  totalCount: number;
  completedCount: number;
  percent: number;
  nextItemKey: ItemKey | null;
}

/** Ghép dòng đã lưu với định nghĩa mục; mục chưa có dòng là `todo`. `not_applicable` không tính vào %. */
export function buildChecklist(
  stored: ReadonlyMap<string, StoredItem>,
  publishedSlugs: ReadonlySet<string>,
): ChecklistView {
  const items = ITEM_KEYS.map((itemKey): ChecklistItemView => {
    const d = ITEM_DEFS[itemKey];
    const s = stored.get(itemKey);
    return {
      itemKey,
      title: d.title,
      description: d.description,
      status: s?.status ?? 'todo',
      auto: d.auto,
      data: s?.data ?? null,
      legalArticleSlug: publishedSlugs.has(d.articleSlug)
        ? d.articleSlug
        : null,
      completedAt: s?.completedAt ?? null,
    };
  });
  const applicable = items.filter((i) => i.status !== 'not_applicable');
  const completedCount = applicable.filter((i) => i.status === 'done').length;
  return {
    items,
    totalCount: applicable.length,
    completedCount,
    percent: applicable.length
      ? Math.floor((completedCount / applicable.length) * 100)
      : 0,
    nextItemKey: items.find((i) => i.status === 'todo')?.itemKey ?? null,
  };
}
