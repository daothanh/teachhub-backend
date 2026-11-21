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
  type StudentLedger,
  type StudentLedgerQuery,
  studentLedgerQuerySchema,
  studentLedgerSchema,
} from './payments.schemas.js';
import {
  type Receivables,
  type ReceivablesQuery,
  receivablesQuerySchema,
  receivablesSchema,
  type StudentReceivableHistory,
  studentReceivableHistorySchema,
} from './receivables.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 6 (S5-FL-09, S5-CT-01): công nợ T11 (thân hàm S6-BE-05, P1) và sổ học viên (S6-BE-03). Chỉ đọc, chỉ `tenant_owner`.
@ApiTags('billing')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller()
export class ReceivablesController {
  @Get('receivables')
  @ApiOperation({
    summary: 'Công nợ và tuổi nợ theo học viên (T11, US-8.3)',
    description:
      'Mỗi dòng một học viên còn nợ: tên, lớp, số nợ, nhóm tuổi nợ 0–30 / 31–60 / > 60 ngày tính từ hạn thanh toán của hóa đơn cũ nhất còn nợ (US-8.3 AC1). Mặc định sắp theo số nợ giảm dần, `summary` có tổng theo từng nhóm (AC2). ' +
      'Lọc: `agingBucket` (`0-30`, `31-60`, `over-60`), `classId`, `q` (tên học viên, không dấu); `summary` tính theo `classId` và `q` đang áp, không theo `agingBucket`; sắp: `sortField` (`amount`, `overdueDays`, `studentName`), `sortOrder`; phân trang offset `page`, `pageSize`. Giá trị ngoài danh sách → 422 `VALIDATION_FAILED`. Số tiền là số nguyên đồng. Mở một dòng bằng `GET /receivables/{studentId}`.',
  })
  @ApiOkResponse({ standardSchema: receivablesSchema })
  @ApiErrors('VALIDATION_FAILED')
  list(
    @Query({ schema: receivablesQuerySchema }) _query: ReceivablesQuery,
  ): Receivables {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('receivables/:studentId')
  @ApiOperation({
    summary:
      'Lịch sử hóa đơn, thanh toán, nhắc nợ của một học viên (T11, US-8.3 AC3)',
    description:
      'Gồm nợ hiện tại, số dư sổ học viên, trạng thái nhắc nợ và các ghi danh đang mở (để bật/tắt nhắc), kèm hóa đơn đã phát hành, thanh toán và lời nhắc mới nhất. Học viên của tenant khác hoặc không tồn tại → 404; học viên hết nợ vẫn xem được (`outstandingAmount = 0`).',
  })
  @ApiOkResponse({ standardSchema: studentReceivableHistorySchema })
  @ApiErrors('NOT_FOUND')
  history(
    @Param('studentId', { schema: idParam }) _studentId: string,
  ): StudentReceivableHistory {
    throw new AppException('NOT_IMPLEMENTED');
  }

  @Get('students/:id/ledger')
  @ApiOperation({
    summary: 'Sổ học viên: nợ cũ, tiền trả thừa, số dư chuyển kỳ (US-7.6)',
    description:
      '`balanceAmount` = Σ(`debitAmount` − `creditAmount`): dương = nợ cũ chưa vào hóa đơn nào, âm = tiền trả thừa chờ trừ. Bản nháp kỳ sau lấy số dư này thành dòng `carry_over` (US-7.6 AC1, AC2): nợ 200.000 đ + phát sinh 1.200.000 đ → dòng "Nợ kỳ trước 200.000 đ", tổng 1.400.000 đ; trả thừa 50.000 đ → dòng trừ 50.000 đ; tổng âm thì hóa đơn 0 đ và phần dư ở lại sổ (AC4). Chênh lệch do sửa điểm danh sau phát hành vào kỳ sau là dòng `prev_adjustment` (AC3). ' +
      '`entries` phân trang offset, mới nhất trước. Học viên của tenant khác → 404; chưa có dòng sổ nào thì số dư 0 và `entries.items` rỗng.',
  })
  @ApiOkResponse({ standardSchema: studentLedgerSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  ledger(
    @Param('id', { schema: idParam }) _id: string,
    @Query({ schema: studentLedgerQuerySchema }) _query: StudentLedgerQuery,
  ): StudentLedger {
    throw new AppException('NOT_IMPLEMENTED');
  }
}
