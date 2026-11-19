// Miền thuần của onboarding (US-0.2): không import NestJS/Drizzle.

export const ONBOARDING_STEPS = [
  'create_class',
  'add_students',
  'set_schedule',
  'payout_account',
  'compliance_checklist',
] as const;
export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStatus = 'pending' | 'done' | 'skipped';

/** Dạng lưu ở `tenants.settings.onboarding.steps`: chỉ ghi bước đã xử lý; thiếu = `pending`. */
export type StoredSteps = Partial<Record<OnboardingStepName, OnboardingStatus>>;

/** US-0.2 AC2: chỉ bước 2 đến 5 được bỏ qua. */
export function canSet(
  step: OnboardingStepName,
  status: 'done' | 'skipped',
): boolean {
  return !(step === 'create_class' && status === 'skipped');
}

export function toView(stored: StoredSteps | undefined) {
  const steps = ONBOARDING_STEPS.map((step) => ({
    step,
    status: stored?.[step] ?? ('pending' as const),
  }));
  return {
    steps,
    currentStep: steps.find((s) => s.status === 'pending')?.step ?? null,
  };
}
