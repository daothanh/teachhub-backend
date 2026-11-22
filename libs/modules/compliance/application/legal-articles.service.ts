import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { AppException, paginated, toLimitOffset } from '@teachhub/core';
import { legalArticles, type Tx } from '@teachhub/db';
import { formatInZone } from '@teachhub/modules/schedule';
import {
  LEGAL_DISCLAIMER,
  type LegalArticleView,
  type LegalArticleViewListQuery,
  type LegalArticleViewPage,
} from '../http/compliance.schemas.js';

const TZ = 'Asia/Ho_Chi_Minh';
type Row = typeof legalArticles.$inferSelect;

const toView = (r: Row): LegalArticleView => ({
  slug: r.slug,
  title: r.title,
  summary: r.summary,
  bodyMarkdown: r.bodyMarkdown,
  sources: r.sources as LegalArticleView['sources'],
  reviewedBy: r.reviewedBy,
  reviewerRole: r.reviewerRole as LegalArticleView['reviewerRole'],
  reviewedOn: r.reviewedOn,
  disclaimer: LEGAL_DISCLAIMER,
  publishedAt: formatInZone(r.publishedAt!, TZ),
  updatedAt: formatInZone(r.updatedAt, TZ),
});

/** `%`, `_`, `\` của người dùng không được thành ký tự đại diện của LIKE. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Thư viện quy định, phần đọc (US-9.6). Chỉ bài `published` đã có người duyệt (RLS `legal_articles_published_read` cùng điều
 * kiện tường minh ở đây); bản nháp và bài không tồn tại cùng 404. Soạn/phát hành thuộc task admin.
 */
@Injectable()
export class LegalArticlesService {
  private readonly visible = and(
    eq(legalArticles.status, 'published'),
    isNotNull(legalArticles.reviewedBy),
  );

  async list(
    tx: Tx,
    q: LegalArticleViewListQuery,
  ): Promise<LegalArticleViewPage> {
    // Cả cột và từ khóa qua cùng hàm bỏ dấu của CSDL.
    const like = q.q
      ? sql`'%' || lower(app_private.f_unaccent(${likeEscape(q.q)})) || '%'`
      : undefined;
    const where = and(
      this.visible,
      like &&
        sql`(lower(app_private.f_unaccent(${legalArticles.title})) like ${like}
          or lower(app_private.f_unaccent(${legalArticles.summary})) like ${like})`,
    );
    const { limit, offset } = toLimitOffset(q);
    const [rows, [agg]] = await Promise.all([
      tx
        .select()
        .from(legalArticles)
        .where(where)
        .orderBy(desc(legalArticles.updatedAt), desc(legalArticles.id))
        .limit(limit)
        .offset(offset),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(legalArticles)
        .where(where),
    ]);
    return paginated(rows.map(toView), agg?.n ?? 0, q);
  }

  async get(tx: Tx, slug: string): Promise<LegalArticleView> {
    const [row] = await tx
      .select()
      .from(legalArticles)
      .where(and(this.visible, eq(legalArticles.slug, slug)));
    if (!row) throw new AppException('NOT_FOUND');
    return toView(row);
  }
}
