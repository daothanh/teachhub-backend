import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiErrors,
  ApiIdempotencyKey,
  Ctx,
  type RequestContext,
} from '@teachhub/core';
import { Idempotency } from '@teachhub/infra';
import { RequiresRole } from '@teachhub/modules/identity';
import { FilesService } from '../application/files.service.js';
import {
  type FileDownloadUrl,
  type FileRecord,
  downloadUrlSchema,
  fileRecordSchema,
  type UploadUrl,
  type UploadUrlRequest,
  uploadUrlRequestSchema,
  uploadUrlSchema,
} from './files.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 8 (S7-CT-01); thân hàm S8-BE-files. Quyền theo `purpose` + thực thể, không theo vai trò đơn lẻ:
// `receipt` do phụ huynh tải lên (`parent`), giáo viên của tenant xem (`tenant_owner`). Tệp của người khác/tenant khác → 404.
// Bài nộp, bài tập, tệp tin nhắn thêm `purpose` ở Sprint 9 (học sinh `student` đã có trong danh sách vai trò).
@ApiTags('files')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner', 'parent', 'student')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN', 'CONSENT_REQUIRED')
@Controller('files')
export class FilesController {
  constructor(
    private readonly idem: Idempotency,
    private readonly files: FilesService,
  ) {}

  @Post('upload-urls')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Xin URL tải tệp lên kho S3 (US-7.7, Spec §3.6c)',
    description:
      'Kiểm quyền với `entityId` theo `purpose`, MIME và kích thước theo bảng giới hạn của `purpose` rồi cấp URL PUT 2 phút; tệp không đi qua API. ' +
      'MIME ngoài danh sách → 422 `FILE_TYPE_NOT_ALLOWED`; quá trần → 422 `FILE_TOO_LARGE`; `entityId` không thấy hoặc không có quyền → 404 `NOT_FOUND`. ' +
      'Gọi lại cùng `Idempotency-Key` trả lại cùng `fileId` và URL. Chưa đồng ý điều khoản → 403 `CONSENT_REQUIRED`. Tối đa 5 tệp `pending` mỗi (người tải, hóa đơn): vượt → 429 `RATE_LIMITED`. Giới hạn 30 lần/phút/user. ' +
      'URL ký cả `Content-Type` và số byte đã khai (`Content-Length`): client gửi khác loại hoặc nhiều/ít byte hơn thì kho S3 từ chối chữ ký (403 từ kho, không qua API), nên URL không dùng để đẩy tệp lớn hơn khai báo.',
  })
  @ApiCreatedResponse({ standardSchema: uploadUrlSchema })
  @ApiIdempotencyKey()
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'FILE_TOO_LARGE',
    'FILE_TYPE_NOT_ALLOWED',
    'RATE_LIMITED',
  )
  createUploadUrl(
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body({ schema: uploadUrlRequestSchema }) body: UploadUrlRequest,
  ): Promise<UploadUrl> {
    return this.idem.run(req, reply, ctx, async (t) => ({
      status: 201,
      body: await this.files.createUploadUrl(t, ctx.userId!, body),
    }));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Xác nhận đã tải xong, tệp sẵn sàng (US-7.7)',
    description:
      'Server HEAD kho S3: không có đối tượng → 409 `CONFLICT_STALE` (client PUT lại bằng URL còn hạn hoặc xin URL mới); nhiều byte hơn khai báo hoặc quá trần → 422 `FILE_TOO_LARGE`, content-type lệch → 422 `FILE_TYPE_NOT_ALLOWED`, ít byte hơn khai báo → 422 `VALIDATION_FAILED` ở `sizeBytes`; cả ba xóa đối tượng (tệp vẫn `pending`, client xin URL mới). ' +
      'Sau khi đủ kích thước và content-type, server đọc vài byte đầu: chữ ký không khớp MIME khai (JPEG/PNG/HEIC) → 422 `FILE_TYPE_NOT_ALLOWED` và xóa đối tượng; tệp `pending` quá 24 giờ → 409 `CONFLICT_STALE`. Chỉ người đã xin URL gọi được (người khác → 404). Gọi lại trên tệp đã `ready` vẫn 200 với bản ghi hiện tại.',
  })
  @ApiOkResponse({ standardSchema: fileRecordSchema })
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'CONFLICT_STALE',
    'FILE_TOO_LARGE',
    'FILE_TYPE_NOT_ALLOWED',
  )
  complete(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<FileRecord> {
    return this.files.complete(ctx.userId!, id);
  }

  @Get(':id/download-url')
  @ApiOperation({
    summary: 'Lấy URL tải tệp (US-7.7)',
    description:
      'URL presigned GET hết hạn sau 10 phút. Quyền theo `purpose` và thực thể: `receipt` do phụ huynh đã tải lên hoặc giáo viên của tenant sở hữu hóa đơn xem; mọi trường hợp khác (kể cả tệp `pending`) → 404 `NOT_FOUND`, không lộ tệp có tồn tại.',
  })
  @ApiOkResponse({ standardSchema: downloadUrlSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  downloadUrl(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) id: string,
  ): Promise<FileDownloadUrl> {
    return this.files.downloadUrl(ctx.userId!, id);
  }
}
