import { z } from 'zod';
import { attendanceStatusSchema } from '@teachhub/modules/attendance';
import { sessionStatusSchema } from '@teachhub/modules/schedule';

// Dữ liệu đã lọc cho phụ huynh (Spec §4.5): không có liên hệ phụ huynh khác, ghi chú giáo viên, học phí.

export const familyStudentSchema = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    classes: z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          teacherName: z.string(),
        }),
      )
      .meta({ description: 'Lớp con đang ghi danh' }),
  })
  .meta({ id: 'FamilyStudent' });
export type FamilyStudent = z.infer<typeof familyStudentSchema>;

export const familyStudentListSchema = z
  .object({ items: z.array(familyStudentSchema) })
  .meta({
    id: 'FamilyStudentList',
    description:
      'Chỉ các con đã liên kết với phụ huynh này (qua lời mời đã nhận)',
    example: {
      items: [
        {
          id: '019b2c4f-0001-7b30-8c01-000000000001',
          fullName: 'Nguyễn Minh Anh',
          classes: [
            {
              id: '019b2c3f-5e01-7c20-9b01-000000000001',
              name: 'Toán 9A',
              teacherName: 'Cô Lan',
            },
          ],
        },
      ],
    },
  });
export type FamilyStudentList = z.infer<typeof familyStudentListSchema>;

export const familyAttendanceQuerySchema = z.object({
  week: z.iso.date().optional().meta({
    description:
      'Một ngày bất kỳ trong tuần cần xem; server lấy tuần Thứ Hai đến Chủ Nhật chứa ngày đó theo múi giờ tenant. Bỏ trống = tuần hiện tại',
    example: '2026-12-15',
  }),
});
export type FamilyAttendanceQuery = z.infer<typeof familyAttendanceQuerySchema>;

export const familyAttendanceWeekSchema = z
  .object({
    studentId: z.uuid(),
    weekStart: z.iso.date(),
    weekEnd: z.iso.date(),
    summary: z
      .object({
        present: z.int().min(0),
        late: z.int().min(0),
        excused: z.int().min(0),
        unexcused: z.int().min(0),
        notRecorded: z.int().min(0).meta({
          description: 'Buổi chưa hủy nhưng chưa có điểm danh',
        }),
      })
      .meta({ description: 'Đếm theo buổi không bị hủy trong tuần' }),
    sessions: z.array(
      z.object({
        sessionId: z.uuid(),
        classId: z.uuid(),
        className: z.string(),
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        sessionStatus: sessionStatusSchema,
        isMakeup: z.boolean(),
        attendanceStatus: attendanceStatusSchema.nullable().meta({
          description: 'null = chưa điểm danh hoặc buổi đã hủy',
        }),
      }),
    ),
  })
  .meta({
    id: 'FamilyAttendanceWeek',
    description:
      'Buổi học trong tuần kèm điểm danh của đúng con này; không có ghi chú của giáo viên và không có dữ liệu học viên khác',
    example: {
      studentId: '019b2c4f-0001-7b30-8c01-000000000001',
      weekStart: '2026-12-14',
      weekEnd: '2026-12-20',
      summary: {
        present: 1,
        late: 0,
        excused: 0,
        unexcused: 1,
        notRecorded: 0,
      },
      sessions: [
        {
          sessionId: '019b2c41-0001-7a10-8a01-000000000001',
          classId: '019b2c3f-5e01-7c20-9b01-000000000001',
          className: 'Toán 9A',
          startsAt: '2026-12-15T18:00:00+07:00',
          endsAt: '2026-12-15T19:30:00+07:00',
          sessionStatus: 'taught',
          isMakeup: false,
          attendanceStatus: 'present',
        },
        {
          sessionId: '019b2c41-0001-7a10-8a01-000000000002',
          classId: '019b2c3f-5e01-7c20-9b01-000000000001',
          className: 'Toán 9A',
          startsAt: '2026-12-17T18:00:00+07:00',
          endsAt: '2026-12-17T19:30:00+07:00',
          sessionStatus: 'taught',
          isMakeup: false,
          attendanceStatus: 'unexcused',
        },
      ],
    },
  });
export type FamilyAttendanceWeek = z.infer<typeof familyAttendanceWeekSchema>;
