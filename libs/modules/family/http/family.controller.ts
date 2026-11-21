import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, Ctx, type RequestContext } from '@teachhub/core';
import { RequiresRole } from '@teachhub/modules/identity';
import { FamilyService } from '../application/family.service.js';
import {
  type FamilyAttendanceQuery,
  familyAttendanceQuerySchema,
  type FamilyAttendanceWeek,
  familyAttendanceWeekSchema,
  type FamilyStudentList,
  familyStudentListSchema,
} from './family.schemas.js';

const idParam = z.uuid();

// Hợp đồng Sprint 4 (S3-FL-12); S4-BE-06. Chỉ đọc. RLS qua `linked_student_ids()` là lớp 2.
@ApiTags('family')
@ApiBearerAuth('bearer')
@RequiresRole('parent')
@ApiErrors('UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN', 'CONSENT_REQUIRED')
@Controller('family')
export class FamilyController {
  constructor(private readonly family: FamilyService) {}

  @Get('students')
  @ApiOperation({
    summary: 'Các con của phụ huynh (P02, US-0.3)',
    description:
      'Chỉ học viên đã liên kết với user qua lời mời đã nhận, ở mọi tenant (phụ huynh nhiều giáo viên thấy hết, US-0.4 AC1). ' +
      'Phụ huynh chưa đồng ý điều khoản hiện hành → 403 `CONSENT_REQUIRED` (`details.termsVersion`), áp dụng cho cả `/family/**` (US-0.3 AC2); user không có vai trò Phụ huynh → 403 `FORBIDDEN`.',
  })
  @ApiOkResponse({ standardSchema: familyStudentListSchema })
  students(@Ctx() ctx: RequestContext): Promise<FamilyStudentList> {
    return this.family.students(ctx.userId!);
  }

  @Get('students/:id/attendance')
  @ApiOperation({
    summary: 'Chuyên cần của con theo tuần (P02, US-0.3 AC4)',
    description:
      'Các buổi học của con trong một tuần kèm trạng thái điểm danh. `id` không phải con đã liên kết với user này (học viên khác, tenant khác, hay không tồn tại) → cùng 404 `NOT_FOUND`, không lộ học viên có tồn tại. ' +
      'Không trả ghi chú của giáo viên, liên hệ hay dữ liệu học viên khác. Không phân trang: một tuần có ít buổi. Chưa có endpoint riêng cho lịch học; danh sách `sessions` đã gồm cả buổi hủy và buổi bù (`isMakeup`).',
  })
  @ApiOkResponse({ standardSchema: familyAttendanceWeekSchema })
  @ApiErrors('VALIDATION_FAILED', 'NOT_FOUND')
  attendance(
    @Ctx() ctx: RequestContext,
    @Param('id', { schema: idParam }) studentId: string,
    @Query({ schema: familyAttendanceQuerySchema })
    query: FamilyAttendanceQuery,
  ): Promise<FamilyAttendanceWeek> {
    return this.family.attendance(ctx.userId!, studentId, query.week);
  }
}
