import { z } from 'zod';

/** Thứ tự 5 bước của US-0.2. Bước 4 và 5 ở Sprint 2 chỉ là màn giữ chỗ. */
export const onboardingStepSchema = z.enum([
  'create_class',
  'add_students',
  'set_schedule',
  'payout_account',
  'compliance_checklist',
]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const onboardingSchema = z
  .object({
    steps: z.array(
      z.object({
        step: onboardingStepSchema,
        status: z.enum(['pending', 'done', 'skipped']),
      }),
    ),
    currentStep: onboardingStepSchema
      .nullable()
      .meta({ description: 'Bước `pending` đầu tiên; null khi đã xử lý hết' }),
  })
  .meta({
    id: 'Onboarding',
    example: {
      steps: [
        { step: 'create_class', status: 'done' },
        { step: 'add_students', status: 'pending' },
        { step: 'set_schedule', status: 'pending' },
        { step: 'payout_account', status: 'pending' },
        { step: 'compliance_checklist', status: 'pending' },
      ],
      currentStep: 'add_students',
    },
  });
export type Onboarding = z.infer<typeof onboardingSchema>;

export const patchOnboardingStepRequestSchema = z
  .object({
    status: z.enum(['done', 'skipped']).meta({
      description:
        '`skipped` chỉ cho bước 2 đến 5 (US-0.2 AC2); bước `create_class` bỏ qua → 422',
    }),
  })
  .meta({ example: { status: 'skipped' } });
export type PatchOnboardingStepRequest = z.infer<
  typeof patchOnboardingStepRequestSchema
>;

export const createCenterWaitlistRequestSchema = z
  .object({
    centerName: z
      .string()
      .trim()
      .min(1, 'Vui lòng nhập tên trung tâm.')
      .max(120)
      .meta({ example: 'Trung tâm Ánh Dương' }),
    teacherCount: z.int().min(1).max(1000).meta({ example: 8 }),
  })
  .meta({ example: { centerName: 'Trung tâm Ánh Dương', teacherCount: 8 } });
export type CreateCenterWaitlistRequest = z.infer<
  typeof createCenterWaitlistRequestSchema
>;

export const centerWaitlistEntrySchema = z
  .object({
    id: z.uuid(),
    centerName: z.string(),
    teacherCount: z.int(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: 'CenterWaitlistEntry',
    example: {
      id: '019b2c30-0001-7a10-8a01-000000000001',
      centerName: 'Trung tâm Ánh Dương',
      teacherCount: 8,
      createdAt: '2026-12-14T09:00:00+07:00',
    },
  });
export type CenterWaitlistEntry = z.infer<typeof centerWaitlistEntrySchema>;
