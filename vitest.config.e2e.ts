import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Giới hạn tần suất theo IP (S1-BE-09): mọi request test đều từ 127.0.0.1; test throttler tự đặt lại 1.
    env: { RATE_LIMIT_SCALE: '1000' },
  },
});
