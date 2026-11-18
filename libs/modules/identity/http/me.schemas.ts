import { z } from 'zod';

/** MVP: chỉ 3 vai trò này; app bỏ qua vai trò lạ (Mục 3.7). */
export const roleSchema = z.enum(['tenant_owner', 'parent', 'student']);

export const membershipSchema = z
  .object({
    id: z.uuid(),
    role: roleSchema,
    /** Nhãn hiển thị ở sheet chuyển vai trò (US-0.11 AC1). */
    label: z.string(),
    tenantId: z.uuid().nullable(),
    studentId: z.uuid().nullable(),
  })
  .meta({ id: 'Membership' });

export const membershipsResponseSchema = z
  .object({
    items: z.array(membershipSchema),
    /** Vai trò dùng gần nhất (US-0.11 AC3); null khi chưa chọn lần nào. */
    lastMembershipId: z.uuid().nullable(),
  })
  .meta({
    example: {
      items: [
        {
          id: '019a8f3e-8a10-7e55-8c1d-2b3c4d5e6f70',
          role: 'tenant_owner',
          label: 'Giáo viên · Cô Lan',
          tenantId: '019a8f3e-8a10-7e55-8c1d-0a1b2c3d4e5f',
          studentId: null,
        },
        {
          id: '019a8f3e-9b21-7f66-9d2e-3c4d5e6f7a81',
          role: 'parent',
          label: 'Phụ huynh',
          tenantId: null,
          studentId: null,
        },
        {
          id: '019a8f3e-ac32-7a77-8e3f-4d5e6f7a8b92',
          role: 'student',
          label: 'Học sinh',
          tenantId: null,
          studentId: null,
        },
      ],
      lastMembershipId: '019a8f3e-8a10-7e55-8c1d-2b3c4d5e6f70',
    },
  });
export type MembershipsResponse = z.infer<typeof membershipsResponseSchema>;

export const activeMembershipRequestSchema = z.object({
  membershipId: z.uuid(),
});
export type ActiveMembershipRequest = z.infer<
  typeof activeMembershipRequestSchema
>;

export const addRoleRequestSchema = z.object({
  role: z.enum(['parent', 'student']),
});
export type AddRoleRequest = z.infer<typeof addRoleRequestSchema>;

export const membershipCreatedSchema = z
  .object({ membershipId: z.uuid() })
  .meta({
    id: 'MembershipCreated',
    example: { membershipId: '019a8f3e-ac32-7a77-8e3f-4d5e6f7a8b92' },
  });
export type MembershipCreated = z.infer<typeof membershipCreatedSchema>;
