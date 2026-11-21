import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, Ctx, type RequestContext } from '@teachhub/core';
import { TxService } from '@teachhub/db';
import { RequiresRole } from '@teachhub/modules/identity';
import { ReportsService } from '../application/reports.service.js';
import {
  type MonthOverview,
  monthOverviewSchema,
  type ReportMonthQuery,
  reportMonthQuerySchema,
  type Revenue12m,
  revenue12mSchema,
  type RevenueByClass,
  revenueByClassSchema,
  type RevenueEntries,
  type RevenueEntriesQuery,
  revenueEntriesQuerySchema,
  revenueEntriesSchema,
} from './reports.schemas.js';

// Hợp đồng Sprint 7 (S6-FL-06, S6-CT-01): báo cáo doanh thu T12. Chỉ đọc, chỉ `tenant_owner` (MVP: giáo viên là chủ tenant).
// Số liệu lấy từ `revenue_ledger` (US-9.5 AC1) nên khớp từng đồng với thanh toán đã ghi (US-7.4 AC3, US-8.1 AC2).
@ApiTags('reports')
@ApiBearerAuth('bearer')
@RequiresRole('tenant_owner')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly tx: TxService,
    private readonly reports: ReportsService,
  ) {}

  @Get('month-overview')
  @ApiOperation({
    summary:
      'Tổng quan tháng: phải thu, đã thu, công nợ, học viên (T12, US-8.1)',
    description:
      'Bốn ô số của màn T12. Đổi tháng chỉ đổi `billedAmount` và `collectedAmount`; `outstandingAmount` và `activeStudentCount` là giá trị hiện tại. Cập nhật ngay khi ghi hoặc hủy thanh toán (US-7.4 AC3 "báo cáo cập nhật"): đọc thẳng từ sổ, không có bảng tổng hợp trễ.',
  })
  @ApiOkResponse({ standardSchema: monthOverviewSchema })
  @ApiErrors('VALIDATION_FAILED')
  monthOverview(
    @Ctx() ctx: RequestContext,
    @Query({ schema: reportMonthQuerySchema }) query: ReportMonthQuery,
  ): Promise<MonthOverview> {
    return this.tx.run(ctx, (t) =>
      this.reports.monthOverview(t, ctx.tenantId!, query),
    );
  }

  @Get('payments')
  @ApiOperation({
    summary:
      'Danh sách khoản thu tạo nên số "Đã thu" của tháng (US-8.1 AC2, AC3)',
    description:
      'Mỗi dòng một bút toán của sổ doanh thu trong tháng, mới nhất trước, gồm cả dòng đảo do hủy thanh toán. `totalAmount` luôn bằng `collectedAmount` của tổng quan. Bổ sung ngoài bảng Spec §5.4: US-8.1 AC3 cần danh sách chi tiết của ô "Đã thu".',
  })
  @ApiOkResponse({ standardSchema: revenueEntriesSchema })
  @ApiErrors('VALIDATION_FAILED')
  payments(
    @Ctx() ctx: RequestContext,
    @Query({ schema: revenueEntriesQuerySchema }) query: RevenueEntriesQuery,
  ): Promise<RevenueEntries> {
    return this.tx.run(ctx, (t) =>
      this.reports.payments(t, ctx.tenantId!, query),
    );
  }

  @Get('revenue-by-class')
  @ApiOperation({
    summary: 'Doanh thu đã thu theo lớp của một tháng (T12, US-8.2)',
    description:
      'Kèm chuyên cần của lớp (hiện ở thẻ "Theo lớp"). Lớp đã lưu trữ vẫn xuất hiện ở tháng cũ (US-8.2 AC2). Tổng các dòng bằng đúng `collectedAmount` của tổng quan (US-8.2 AC3): quy tắc chia thanh toán của hóa đơn nhiều lớp ghi ở schema.',
  })
  @ApiOkResponse({ standardSchema: revenueByClassSchema })
  @ApiErrors('VALIDATION_FAILED')
  revenueByClass(
    @Ctx() ctx: RequestContext,
    @Query({ schema: reportMonthQuerySchema }) query: ReportMonthQuery,
  ): Promise<RevenueByClass> {
    return this.tx.run(ctx, (t) =>
      this.reports.revenueByClass(t, ctx.tenantId!, query),
    );
  }

  @Get('revenue-12m')
  @ApiOperation({
    summary: 'Doanh thu đã thu 12 tháng gần nhất (T12, US-8.2 AC1)',
    description:
      '12 tháng liên tiếp kết thúc ở `month` (mặc định tháng hiện tại), cũ nhất trước; cột "T12 … T11" của biểu đồ. Mỗi cột bằng `collectedAmount` của tháng đó.',
  })
  @ApiOkResponse({ standardSchema: revenue12mSchema })
  @ApiErrors('VALIDATION_FAILED')
  revenue12m(
    @Ctx() ctx: RequestContext,
    @Query({ schema: reportMonthQuerySchema }) query: ReportMonthQuery,
  ): Promise<Revenue12m> {
    return this.tx.run(ctx, (t) =>
      this.reports.revenue12m(t, ctx.tenantId!, query),
    );
  }
}
