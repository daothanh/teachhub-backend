// Quy tắc nghiệp vụ thuần của lớp (US-1.1 AC1-AC2); không phụ thuộc NestJS/Drizzle.

export interface ClassDraft {
  mode: 'offline' | 'online';
  location: string | null;
  startDate: string;
  endDate: string | null;
}

/** Lỗi theo trường (cùng dạng `errors` của VALIDATION_FAILED); rỗng = hợp lệ. Dùng cho bản đã gộp khi PATCH. */
export function classDraftErrors(c: ClassDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (c.mode === 'offline' && !c.location?.trim()) {
    errors.location = ['Vui lòng nhập địa điểm cho lớp học tại chỗ.'];
  }
  if (c.endDate && c.endDate < c.startDate) {
    errors.endDate = ['Ngày kết thúc không được trước ngày bắt đầu.'];
  }
  return errors;
}
