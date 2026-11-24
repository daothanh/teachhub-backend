import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Helper cho hành trình onboarding (US-0.1 đăng nhập, US-0.10 chọn vai trò, US-0.2 5 bước):
 * gửi/đọc OTP qua Mailpit, đăng nhập, chọn vai trò Giáo viên rồi gọi các endpoint onboarding.
 * Tách khỏi spec để test đọc như kịch bản, không lẫn chi tiết hạ tầng.
 */
export interface JourneyUser {
  email: string;
  token: string;
  userId: string;
}

export interface OnboardingStep {
  step: string;
  status: string;
}

export interface OnboardingView {
  steps: OnboardingStep[];
  currentStep: string | null;
}

/** `mailApiBase`: gốc API Mailpit, ví dụ `http://127.0.0.1:<port>/api/v1`. */
export function onboardingJourney(
  app: NestFastifyApplication,
  mailApiBase: string,
) {
  const sendOtp = (email: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/otp/send',
      payload: { email },
    });

  const login = (email: string, code: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { method: 'email_otp', email, code },
    });

  /**
   * Mã trong email OTP mới nhất gửi tới `email` (tiêu đề "<mã> là mã đăng nhập…").
   * Chờ tối đa 10 giây cho Mailpit nhận và đánh chỉ mục thư: SMTP tới Mailpit là bất đồng bộ,
   * đọc một lần ngay sau `send` dễ trượt khi máy chạy container bị tải.
   */
  const lastCode = async (email: string): Promise<string> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await fetch(`${mailApiBase}/messages`);
      const { messages } = (await res.json()) as {
        messages: { To: { Address: string }[]; Subject: string }[];
      };
      const msg = messages.find((m) => m.To[0]?.Address === email);
      const code = msg?.Subject.match(/^(\d{6}) /)?.[1];
      if (code) return code;
      if (Date.now() >= deadline) {
        throw new Error(`không thấy email OTP cho ${email} sau 10 giây`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  /** Một mã 6 số khác chắc chắn không khớp (lệch 1 đơn vị, quấn vòng 1_000_000). */
  const wrongCodeOf = (code: string) =>
    ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

  /** Email mới → gửi mã → đọc mã trong Mailpit → đăng nhập: user chưa có vai trò, chưa có tenant. */
  const loginNewUser = async (): Promise<JourneyUser> => {
    const email = `gv.${randomUUID().slice(0, 8)}@example.com`;
    const sent = await sendOtp(email);
    if (sent.statusCode !== 204) throw new Error(`gửi OTP: ${sent.body}`);
    const res = await login(email, await lastCode(email));
    if (res.statusCode !== 200) throw new Error(`đăng nhập: ${res.body}`);
    const body = res.json() as { access_token: string; user: { id: string } };
    return { email, token: body.access_token, userId: body.user.id };
  };

  /** Chọn vai trò Giáo viên: tạo tenant + chi nhánh mặc định + membership `tenant_owner` (US-0.10 AC2). */
  const chooseTeacher = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {},
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
      },
    });

  const getOnboarding = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/onboarding',
      headers: { authorization: `Bearer ${token}` },
    });

  const patchStep = (
    token: string,
    step: string,
    status: 'done' | 'skipped',
    key = randomUUID(),
  ) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/onboarding/steps/${step}`,
      payload: { status },
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    });

  const statusesOf = (res: { json: () => OnboardingView }) =>
    Object.fromEntries(res.json().steps.map((s) => [s.step, s.status]));

  /** User đã chọn vai trò Giáo viên, sẵn sàng gọi onboarding. */
  const teacherOwner = async (): Promise<JourneyUser & { tenantId: string }> => {
    const u = await loginNewUser();
    const ws = await chooseTeacher(u.token);
    if (ws.statusCode !== 201) throw new Error(`tạo workspace: ${ws.body}`);
    return { ...u, tenantId: (ws.json() as { tenantId: string }).tenantId };
  };

  return {
    sendOtp,
    login,
    lastCode,
    wrongCodeOf,
    loginNewUser,
    chooseTeacher,
    getOnboarding,
    patchStep,
    statusesOf,
    teacherOwner,
  };
}
