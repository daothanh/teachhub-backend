import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { Env } from '@teachhub/core';

/**
 * Lớp duy nhất nói chuyện với kho S3 (Mục 2.8). Chỉ dùng tập con S3 mà MinIO, R2 và AWS S3 cùng hỗ trợ,
 * để đổi nhà cung cấp chỉ cần đổi biến `S3_*`. Presigned URL, upload thêm khi có module `files`.
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
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY'),
      },
    });
    this.privateBucket = config.get('S3_BUCKET_PRIVATE');
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
