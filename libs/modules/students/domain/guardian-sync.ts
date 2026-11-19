// Đồng bộ danh sách phụ huynh khi PATCH/POST học viên (US-1.4): có `id` = cập nhật, không `id` = tạo mới,
// phụ huynh hiện có mà vắng trong danh sách = gỡ. Hàm thuần, không phụ thuộc NestJS/Drizzle.

export interface GuardianSyncPlan<T extends { id?: string | undefined }> {
  /** Lỗi theo trường dạng `guardians.N.id` (cùng dạng `errors` của VALIDATION_FAILED); rỗng = hợp lệ. */
  errors: Record<string, string[]>;
  toRemove: string[];
  toUpdate: (T & { id: string })[];
  toCreate: T[];
}

/**
 * `existingIds`: phụ huynh đang liên kết với CHÍNH học viên này (trong tenant hiện tại). Id không nằm trong đó
 * (không tồn tại, của học viên khác, của tenant khác) cho cùng một lỗi nên không lộ id nào có thật.
 */
export function planGuardianSync<T extends { id?: string | undefined }>(
  existingIds: string[],
  input: T[],
): GuardianSyncPlan<T> {
  const known = new Set(existingIds);
  const seen = new Set<string>();
  const plan: GuardianSyncPlan<T> = {
    errors: {},
    toRemove: [],
    toUpdate: [],
    toCreate: [],
  };
  input.forEach((g, i) => {
    if (g.id === undefined) {
      plan.toCreate.push(g);
      return;
    }
    if (!known.has(g.id) || seen.has(g.id)) {
      plan.errors[`guardians.${i}.id`] = [
        'Phụ huynh không thuộc học viên này.',
      ];
      return;
    }
    seen.add(g.id);
    plan.toUpdate.push({ ...g, id: g.id });
  });
  plan.toRemove = existingIds.filter((id) => !seen.has(id));
  return plan;
}
