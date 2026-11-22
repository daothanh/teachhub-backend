import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AppException, uuidv7 } from '@teachhub/core';
import { files, type Tx, TxService } from '@teachhub/db';
import { ObjectStorage } from '@teachhub/infra';
import { ConsentsService } from '@teachhub/modules/identity';
import {
  extensionFor,
  MAGIC_BYTES,
  matchesMagic,
  MAX_PENDING_PER_ENTITY,
  PENDING_TTL_HOURS,
  PUT_TTL_SEC,
  type FilePurpose,
  normalizeMime,
  objectKeyOf,
  PRESIGN_TTL_SEC,
  PURPOSE_POLICY,
} from '../domain/file-policy.js';
import type {
  FileDownloadUrl,
  FileRecord,
  UploadUrl,
  UploadUrlRequest,
} from '../http/files.schemas.js';

type FileRow = typeof files.$inferSelect;

const toRecord = (r: FileRow): FileRecord => ({
  id: r.id,
  purpose: r.purpose as FilePurpose,
  entityId: r.entityId,
  fileName: r.originalName,
  mimeType: r.mime,
  sizeBytes: r.sizeBytes,
  status: r.status as FileRecord['status'],
  createdAt: r.createdAt.toISOString(),
});

/**
 * Tệp qua presigned URL (S8-BE-files, US-7.7, Spec §3.6c). Tệp không đi qua API: API chỉ kiểm quyền/loại/kích thước rồi cấp URL,
 * `complete` HEAD kho S3 để xác minh. `tenant_id` của tệp lấy từ thực thể (hóa đơn), không từ vai trò đang mở của người gọi.
 * Quyền do RLS quyết (người tải lên hoặc nhân sự tenant sở hữu hóa đơn đọc được), service chỉ thêm điều kiện người xin URL.
 * Không đoán được: khóa đối tượng chứa UUID v4 ngẫu nhiên; khóa và URL không bao giờ lộ qua `FileRecord`.
 * shortcut: đọc chéo bảng `invoices`/`family_students()` của billing bằng SQL thô để kiểm quyền thực thể `receipt`; khi có thêm
 * `purpose` (Sprint 9) tách thành port theo từng thực thể.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly tx: TxService,
    private readonly storage: ObjectStorage,
    private readonly consents: ConsentsService,
  ) {}

  async createUploadUrl(
    t: Tx,
    userId: string,
    body: UploadUrlRequest,
  ): Promise<UploadUrl> {
    const policy = PURPOSE_POLICY[body.purpose];
    // `receipt`: hóa đơn đã phát hành của con còn học đã liên kết với user này (cùng điều kiện `GET /family/invoices/{id}`).
    const [inv] = (
      await t.execute<{ tenant_id: string }>(sql`
        select i.tenant_id from invoices i
         where i.id = ${body.entityId}::uuid and i.status <> 'draft'
           and i.student_id in (select fs.student_id from app_private.family_students() fs)`)
    ).rows;
    if (!inv) throw new AppException('NOT_FOUND');
    await this.consents.assertAccepted(userId, 'parent');
    const ext = extensionFor(body.purpose, body.mimeType);
    if (!ext) throw new AppException('FILE_TYPE_NOT_ALLOWED');
    if (body.sizeBytes > policy.maxBytes)
      throw new AppException('FILE_TOO_LARGE');

    // Tối đa N tệp pending mỗi (người tải, hóa đơn); khóa tư vấn để hai request song song không cùng vượt.
    await t.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`files:${userId}:${body.entityId}`}, 0))`,
    );
    const [{ n } = { n: 0 }] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(files)
      .where(
        and(
          eq(files.ownerUserId, userId),
          eq(files.entityId, body.entityId),
          eq(files.status, 'pending'),
          sql`${files.createdAt} > now() - make_interval(hours => ${PENDING_TTL_HOURS})`,
        ),
      );
    if (n >= MAX_PENDING_PER_ENTITY) throw new AppException('RATE_LIMITED');

    const mime = normalizeMime(body.mimeType);
    const id = uuidv7();
    const key = objectKeyOf({
      tenantId: inv.tenant_id,
      purpose: body.purpose,
      entityId: body.entityId,
      random: randomUUID(),
      ext,
    });
    await t.insert(files).values({
      id,
      tenantId: inv.tenant_id,
      ownerUserId: userId,
      purpose: body.purpose,
      entityId: body.entityId,
      bucket: this.storage.bucket,
      objectKey: key,
      originalName: body.fileName,
      mime,
      sizeBytes: body.sizeBytes,
    });
    const uploadUrl = await this.storage.presignPut(
      key,
      mime,
      body.sizeBytes,
      PUT_TTL_SEC,
    );
    return {
      fileId: id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': mime },
      expiresAt: new Date(Date.now() + PUT_TTL_SEC * 1000).toISOString(),
    };
  }

  /** Chỉ người đã xin URL (RLS chặn tenant khác; điều kiện `owner_user_id` loại cả nhân sự tenant). HEAD không giữ giao dịch DB. */
  async complete(userId: string, id: string): Promise<FileRecord> {
    const file = await this.tx.run({ userId }, async (t) => {
      const [r] = await t
        .select()
        .from(files)
        .where(and(eq(files.id, id), eq(files.ownerUserId, userId)));
      return r;
    });
    if (!file) throw new AppException('NOT_FOUND');
    if (file.status === 'ready') return toRecord(file);
    // Quá hạn pending: job dọn có thể đang xóa; không cho hoàn tất tệp cũ.
    if (Date.now() - file.createdAt.getTime() > PENDING_TTL_HOURS * 3_600_000)
      throw new AppException('CONFLICT_STALE');

    const head = await this.storage.head(file.objectKey);
    if (!head) throw new AppException('CONFLICT_STALE');
    const cap = PURPOSE_POLICY[file.purpose as FilePurpose].maxBytes;
    const bad = (() => {
      if (head.sizeBytes > file.sizeBytes || head.sizeBytes > cap)
        return new AppException('FILE_TOO_LARGE');
      if (normalizeMime(head.contentType ?? '') !== file.mime)
        return new AppException('FILE_TYPE_NOT_ALLOWED');
      // Nhỏ hơn khai báo: không khớp nhưng không "quá lớn"; từ chối bằng lỗi theo trường.
      if (head.sizeBytes !== file.sizeBytes)
        return new AppException('VALIDATION_FAILED', undefined, {
          sizeBytes: ['Kích thước tệp tải lên không khớp với khai báo.'],
        });
      return null;
    })();
    if (!bad) {
      // Chữ ký thật của nội dung phải khớp MIME đã khai (Content-Type do client tự khai).
      const first = await this.storage.firstBytes(file.objectKey, MAGIC_BYTES);
      if (!first) throw new AppException('CONFLICT_STALE');
      if (!matchesMagic(file.mime, first))
        return this.reject(file.objectKey, 'FILE_TYPE_NOT_ALLOWED');
    }
    if (bad) {
      await this.storage.delete(file.objectKey);
      throw bad;
    }
    return this.tx.run({ userId }, async (t) => {
      const [done] = await t
        .update(files)
        .set({ status: 'ready', readyAt: sql`now()`, etag: head.etag })
        .where(
          and(
            eq(files.id, id),
            eq(files.ownerUserId, userId),
            eq(files.status, 'pending'),
          ),
        )
        .returning();
      if (done) return toRecord(done);
      // Request `complete` song song đã chuyển `ready`.
      const [again] = await t.select().from(files).where(eq(files.id, id));
      if (!again) throw new AppException('NOT_FOUND');
      return toRecord(again);
    });
  }

  private async reject(
    key: string,
    code: 'FILE_TYPE_NOT_ALLOWED',
  ): Promise<never> {
    await this.storage.delete(key);
    throw new AppException(code);
  }

  /** RLS: người tải lên hoặc nhân sự tenant. Mọi trường hợp khác, kể cả `pending`, cùng 404. */
  async downloadUrl(userId: string, id: string): Promise<FileDownloadUrl> {
    const file = await this.tx.run({ userId }, async (t) => {
      const [r] = await t.select().from(files).where(eq(files.id, id));
      return r;
    });
    if (!file || file.status !== 'ready') throw new AppException('NOT_FOUND');
    return {
      url: await this.storage.presignGet(file.objectKey, PRESIGN_TTL_SEC),
      expiresAt: new Date(Date.now() + PRESIGN_TTL_SEC * 1000).toISOString(),
    };
  }
}
