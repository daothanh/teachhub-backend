import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import { complianceItems, legalArticles, type Tx } from '@teachhub/db';
import { formatInZone } from '@teachhub/modules/schedule';
import {
  buildChecklist,
  ITEM_DEFS,
  ITEM_KEYS,
  type ItemKey,
  type ItemStatus,
  type StoredItem,
} from '../domain/checklist.js';
import type {
  ComplianceChecklist,
  UpdateChecklistItemRequest,
} from '../http/compliance.schemas.js';

const TZ = 'Asia/Ho_Chi_Minh';

/** Slug (trong số `slugs`) của bài đã phát hành; RLS của app đã lọc bản nháp, điều kiện `status` là lớp thứ hai. */
export async function publishedSlugs(
  tx: Tx,
  slugs: readonly string[],
): Promise<Set<string>> {
  const rows = await tx
    .select({ slug: legalArticles.slug })
    .from(legalArticles)
    .where(
      and(
        inArray(legalArticles.slug, [...slugs]),
        eq(legalArticles.status, 'published'),
      ),
    );
  return new Set(rows.map((r) => r.slug));
}

/** Checklist tuân thủ T13 (US-9.1). Mọi gói dùng đủ. */
@Injectable()
export class ChecklistService {
  private readonly log = new Logger(ChecklistService.name);

  async get(tx: Tx, tenantId: string): Promise<ComplianceChecklist> {
    const rows = await tx
      .select()
      .from(complianceItems)
      .where(eq(complianceItems.tenantId, tenantId));
    const stored = new Map<string, StoredItem>(
      rows.map((r) => [
        r.itemKey,
        {
          status: r.status as ItemStatus,
          data: (r.data as StoredItem['data']) ?? null,
          completedAt: r.completedAt ? formatInZone(r.completedAt, TZ) : null,
        },
      ]),
    );
    const slugs = await publishedSlugs(
      tx,
      ITEM_KEYS.map((k) => ITEM_DEFS[k].articleSlug),
    );
    return buildChecklist(stored, slugs) satisfies ComplianceChecklist;
  }

  async update(
    tx: Tx,
    tenantId: string,
    itemKey: ItemKey,
    body: UpdateChecklistItemRequest,
  ): Promise<ComplianceChecklist> {
    if (ITEM_DEFS[itemKey].auto) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        itemKey: ['Mục này do hệ thống tự cập nhật, không đánh dấu tay được.'],
      });
    }
    const wantsNumber =
      itemKey === 'registration_number' && body.status === 'done';
    if (wantsNumber && !body.data) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        'data.registrationNo': ['Vui lòng nhập số giấy chứng nhận.'],
      });
    }
    if (!wantsNumber && body.data) {
      throw new AppException('VALIDATION_FAILED', undefined, {
        data: ['Mục này không nhận dữ liệu nhập.'],
      });
    }
    const [prev] = await tx
      .select({ status: complianceItems.status })
      .from(complianceItems)
      .where(
        and(
          eq(complianceItems.tenantId, tenantId),
          eq(complianceItems.itemKey, itemKey),
        ),
      );
    const done = body.status === 'done';
    await tx
      .insert(complianceItems)
      .values({
        id: uuidv7(),
        tenantId,
        itemKey,
        status: body.status,
        data: body.data ?? null,
        completedAt: done ? sql`now()` : null,
      })
      .onConflictDoUpdate({
        target: [complianceItems.tenantId, complianceItems.itemKey],
        set: {
          status: body.status,
          data: body.data ?? null,
          // Gọi lại cùng nội dung giữ nguyên thời điểm hoàn thành.
          completedAt: done
            ? sql`coalesce(${complianceItems.completedAt}, now())`
            : null,
        },
      });
    // shortcut: analytics chưa có kênh (như onboarding): ghi log có cấu trúc, không PII, khi mục chuyển sang `done`.
    if (done && prev?.status !== 'done') {
      this.log.log({ event: 'compliance_item_completed', item_key: itemKey });
    }
    return this.get(tx, tenantId);
  }
}
