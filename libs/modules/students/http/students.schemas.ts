import { z } from 'zod';
import {
  guardianInviteStatusSchema,
  latestInviteSchema,
  pageQuerySchema,
  paginatedSchema,
} from '@teachhub/core';

const phone = z
  .string()
  .regex(/^\+?[0-9]{8,15}$/, 'Số điện thoại chưa đúng.')
  .meta({ example: '0912345678' });

export const guardianInputSchema = z.object({
  id: z.uuid().optional().meta({
    description: 'Có `id` = cập nhật phụ huynh đó; không có = tạo mới',
  }),
  fullName: z.string().trim().min(1, 'Vui lòng nhập tên phụ huynh.').max(120),
  relation: z.enum(['father', 'mother', 'guardian']).default('guardian'),
  phone: phone.nullish(),
  email: z.email().max(254).nullish(),
});

export const studentCandidateSchema = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    dob: z.iso.date().nullable(),
    school: z.string().nullable(),
  })
  .meta({ id: 'StudentCandidate' });

export const studentDuplicateDetailsSchema = z.object({
  candidates: z.array(studentCandidateSchema).max(5),
});

export const guardianSchema = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    relation: z.enum(['father', 'mother', 'guardian']),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    inviteStatus: guardianInviteStatusSchema,
    latestInvite: latestInviteSchema,
  })
  .meta({ id: 'Guardian' });

const studentFields = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, 'Vui lòng nhập họ tên học viên.')
    .max(120)
    .meta({ example: 'Nguyễn Minh Anh' }),
  dob: z.iso.date().nullish(),
  school: z.string().trim().max(120).nullish(),
  schoolClass: z.string().trim().max(40).nullish().meta({ example: '9A3' }),
  note: z.string().trim().max(1000).nullish(),
  guardians: z
    .array(guardianInputSchema)
    .max(2)
    .meta({ description: 'Tối đa 2 phụ huynh' }),
});

export const createStudentRequestSchema = studentFields
  .extend({
    id: z.uuid().optional().meta({
      description: 'UUID do client sinh (tùy chọn); thiếu thì server sinh',
    }),
    guardians: studentFields.shape.guardians.default([]),
    confirmNew: z.boolean().default(false).meta({
      description:
        'Đặt `true` sau khi người dùng xác nhận "không phải cùng một em" để bỏ qua kiểm tra trùng',
    }),
  })
  .meta({
    example: {
      fullName: 'Nguyễn Minh Anh',
      dob: '2011-05-20',
      school: 'THCS Lê Lợi',
      schoolClass: '9A3',
      guardians: [
        { fullName: 'Nguyễn Văn Hải', relation: 'father', phone: '0912345678' },
      ],
    },
  });
export type CreateStudentRequest = z.infer<typeof createStudentRequestSchema>;

/**
 * Chỉ gửi trường đổi. Có `guardians` thì thay toàn bộ danh sách: phụ huynh có `id` được cập nhật,
 * không có `id` được tạo mới, phụ huynh không còn trong danh sách bị gỡ liên kết.
 */
export const updateStudentRequestSchema = studentFields
  .partial()
  .meta({ example: { schoolClass: '9A4' } });
export type UpdateStudentRequest = z.infer<typeof updateStudentRequestSchema>;

const studentExample = {
  id: '019b2c4f-0001-7b30-8c01-000000000001',
  fullName: 'Nguyễn Minh Anh',
  dob: '2011-05-20',
  school: 'THCS Lê Lợi',
  schoolClass: '9A3',
  note: null,
  status: 'active',
  guardians: [
    {
      id: '019b2c4f-0002-7b30-8c01-000000000001',
      fullName: 'Nguyễn Văn Hải',
      relation: 'father',
      phone: '0912345678',
      email: null,
      inviteStatus: 'not_invited',
      latestInvite: null,
    },
  ],
};

export const studentSchema = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    dob: z.iso.date().nullable(),
    school: z.string().nullable(),
    schoolClass: z.string().nullable(),
    note: z.string().nullable(),
    status: z.enum(['active', 'paused', 'left']),
    guardians: z.array(guardianSchema),
  })
  .meta({ id: 'Student', example: studentExample });
export type Student = z.infer<typeof studentSchema>;

export const studentListQuerySchema = pageQuerySchema.extend({
  status: z.enum(['active', 'paused', 'left']).default('active'),
  classId: z
    .uuid()
    .optional()
    .meta({ description: 'Chỉ học viên đang ghi danh ở lớp này' }),
  q: z.string().trim().min(2).max(100).optional().meta({
    description: 'Tìm theo họ tên, không phân biệt dấu',
    example: 'nguyen minh',
  }),
});
export type StudentListQuery = z.infer<typeof studentListQuerySchema>;

export const studentPageSchema = paginatedSchema(studentSchema).meta({
  id: 'StudentPage',
  example: { items: [studentExample], total: 1, page: 1, pageSize: 20 },
});
export type StudentPage = z.infer<typeof studentPageSchema>;
