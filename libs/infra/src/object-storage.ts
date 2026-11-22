import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '@teachhub/core';

/**
 * Lớp duy nhất nói chuyện với kho S3 (Mục 2.8). Chỉ dùng tập con S3 mà MinIO, R2 và AWS S3 cùng hỗ trợ,
 * để đổi nhà cung cấp chỉ cần đổi biến `S3_*`. Presigned URL (PUT/GET), HEAD và xóa đối tượng dùng cho module `files`; tệp không
 * đi qua API. Chỉ làm việc với bucket private (bucket public của PDF Mẫu 02 thêm cùng task `compliance`).
 */
@Injectable()
export class ObjectStorage {
  private readonly client: S3Client;
  private readonly privateBucket: string;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT'),
      region: config.get('S3_REGION'),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
      // R2/MinIO không nhận checksum mặc định của SDK mới: presigned PUT kèm `x-amz-checksum-crc32` của thân rỗng sẽ từ chối tệp thật.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY'),
      },
    });
    this.privateBucket = config.get('S3_BUCKET_PRIVATE');
  }

  get bucket(): string {
    return this.privateBucket;
  }

  /**
   * URL PUT hết hạn sau `expiresInSec`. `Content-Type` và `Content-Length` được ký: client phải gửi đúng loại và đúng số byte đã
   * khai (khác đi kho từ chối chữ ký), nên URL không dùng để đẩy tệp lớn hơn khai báo vào kho.
   */
  presignPut(
    key: string,
    contentType: string,
    sizeBytes: number,
    expiresInSec: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.privateBucket,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      }),
      {
        expiresIn: expiresInSec,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  presignGet(key: string, expiresInSec: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.privateBucket, Key: key }),
      { expiresIn: expiresInSec },
    );
  }

  /** Kích thước và content-type thật của đối tượng; `null` nếu chưa có. Lỗi khác (mạng, quyền) ném ra. */
  async head(key: string): Promise<{
    sizeBytes: number;
    contentType: string | null;
    etag: string | null;
  } | null> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.privateBucket, Key: key }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return {
        sizeBytes: r.ContentLength ?? 0,
        contentType: r.ContentType ?? null,
        etag: r.ETag ?? null,
      };
    } catch (e) {
      const err = e as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)
        return null;
      throw e;
    }
  }

  /** Vài byte đầu của đối tượng (GET Range) để kiểm magic bytes; đối tượng không có → `null`. */
  /** `ifMatch`: đọc đúng phiên bản đã HEAD; đối tượng bị ghi đè giữa chừng → null (412). */
  async firstBytes(
    key: string,
    n: number,
    ifMatch?: string,
  ): Promise<Uint8Array | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({
          Bucket: this.privateBucket,
          Key: key,
          Range: `bytes=0-${n - 1}`,
          IfMatch: ifMatch,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return (await r.Body?.transformToByteArray()) ?? null;
    } catch (e) {
      const err = e as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      const status = err.$metadata?.httpStatusCode;
      if (err.name === 'NoSuchKey' || status === 404 || status === 412)
        return null;
      throw e;
    }
  }

  /** Xóa đối tượng (idempotent: S3 trả thành công khi không có). */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.privateBucket, Key: key }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }

  /** Cho `/health/ready`: bucket private đọc được bằng khóa hiện tại. ListObjectsV2 thay HeadBucket vì nằm trong tập con chung. */
  async ping(timeoutMs = 2000): Promise<void> {
    await this.client.send(
      new ListObjectsV2Command({ Bucket: this.privateBucket, MaxKeys: 1 }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
  }
}

@Global()
@Module({ providers: [ObjectStorage], exports: [ObjectStorage] })
export class ObjectStorageModule {}
