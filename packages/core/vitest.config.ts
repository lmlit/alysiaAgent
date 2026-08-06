import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.contract.ts'],
    // 固定时区：localDateKeyFromISO 等用例依赖东八区（如 2026-08-06T16:00:00Z → 08-07）
    env: { TZ: 'Asia/Shanghai' },
  },
});
