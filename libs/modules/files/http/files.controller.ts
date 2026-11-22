import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, ApiIdempotencyKey, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
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

// Hợp đồng Sprint 8 (S7-CT-01), thân hàm 501 tới task backend `files`. Quyền theo `purpose` + thực thể, không theo vai trò đơn lẻ:
// `receipt` do phụ huynh tải lên (`parent`), giáo viên của tenant xem (`tenant_owner`). Tệp của người khác/tenant khác → 404.
// Bài nộp, bài tập, tệp tin nhắn thêm `purpose` ở Sprint 9 (học sinh `student` đã có trong danh sách vai trò).
@ApiTags('files')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner', 'parent', 'student')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN', 'CONSENT_REQUIRED')
@Controller('files')
export class FilesController {
  @Post('upload-urls')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Xin URL tải tệp lên kho S3 (US-7.7, Spec §3.6c)',
    description:
      'Kiểm quyền với `entityId` theo `purpose`, MIME và kích thước theo bảng giới hạn của `purpose` rồi cấp URL PUT 10 phút; tệp không đi qua API. ' +
      'MIME ngoài danh sách → 422 `FILE_TYPE_NOT_ALLOWED`; quá trần → 422 `FILE_TOO_LARGE`; `entityId` không thấy hoặc không có quyền → 404 `NOT_FOUND`. ' +
      'Gọi lại cùng `Idempotency-Key` trả lại cùng `fileId` và URL. Giới hạn 30 lần/phút/user.',
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
    @Body({ schema: uploadUrlRequestSchema }) _body: UploadUrlRequest,
  ): UploadUrl {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Xác nhận đã tải xong, tệp sẵn sàng (US-7.7)',
    description:
      'Server HEAD kho S3: không có đối tượng → 409 `CONFLICT_STALE` (client PUT lại bằng URL còn hạn hoặc xin URL mới); kích thước hoặc content-type lệch với khai báo → 422 `FILE_TOO_LARGE` hoặc `FILE_TYPE_NOT_ALLOWED` và xóa đối tượng. ' +
      'Chỉ người đã xin URL gọi được (người khác → 404). Gọi lại trên tệp đã `ready` vẫn 200 với bản ghi hiện tại.',
  })
  @ApiOkResponse({ standardSchema: fileRecordSchema })
  @ApiErrors(
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'CONFLICT_STALE',
    'FILE_TOO_LARGE',
    'FILE_TYPE_NOT_ALLOWED',
  )
  complete(@Param('id', { schema: idParam }) _id: string): FileRecord {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get(':id/download-url')
  @ApiOperation({
    summary: 'Lấy URL tải tệp (US-7.7)',
    description:
      'URL presigned GET hết hạn sau 10 phút. Quyền theo `purpose` và thực thể: `receipt` do phụ huynh đã tải lên hoặc giáo viên của tenant sở hữu hóa đơn xem; mọi trường hợp khác (kể cả tệp `pending`) → 404 `NOT_FOUND`, không lộ tệp có tồn tại.',
  })
  @ApiOkResponse({ standardSchema: downloadUrlSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  downloadUrl(@Param('id', { schema: idParam }) _id: string): FileDownloadUrl {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
