import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, AppException } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import {
  type FamilyInvoice,
  familyInvoiceSchema,
  type FamilyInvoiceList,
  familyInvoiceListSchema,
  type FamilyInvoicesQuery,
  familyInvoicesQuerySchema,
} from './billing.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 5 (S4-FL-10); thân hàm ở S5-BE-08. Chỉ đọc. Vai trò `parent`: học sinh (role `student`) gọi → 403, nên học sinh
// không thấy học phí (US-0.6 AC3). RLS qua `linked_student_ids()` là lớp 2: phụ huynh X không đọc được hóa đơn của Y.
@ApiTags('family')
@ApiBearerAuth('bearer')
@RequiresRole('parent')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN', 'CONSENT_REQUIRED')
@Controller('family/invoices')
export class FamilyInvoicesController {
  @Get()
  @ApiOperation({
    summary: 'Hóa đơn của các con (P03, US-7.3)',
    description:
      'Chỉ hóa đơn đã phát hành (hoặc đã hủy) của học viên đã liên kết với user này, ở mọi tenant. Bản nháp không bao giờ lộ. Chưa đồng ý điều khoản hiện hành → 403 `CONSENT_REQUIRED`. ' +
      '`studentId` không phải con đã liên kết cho danh sách rỗng, không lộ học viên có tồn tại.',
  })
  @ApiOkResponse({ standardSchema: familyInvoiceListSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Query({ schema: familyInvoicesQuerySchema }) _query: FamilyInvoicesQuery,
  ): FamilyInvoiceList {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Chi tiết hóa đơn kèm VietQR cho phụ huynh (P03, US-7.3 AC1)',
    description:
      'Hóa đơn của học viên khác, của tenant khác, bản nháp hay không tồn tại → cùng 404 `NOT_FOUND`. `qrPayload` là chuỗi VietQR đã chứa số tiền và nội dung chuyển khoản; client vẽ QR, cho lưu ảnh và sao chép `transferNote`.',
  })
  @ApiOkResponse({ standardSchema: familyInvoiceSchema })
  @ApiErrors('NOT_FOUND')
  get(@Param('id', { schema: idParam }) _id: string): FamilyInvoice {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
