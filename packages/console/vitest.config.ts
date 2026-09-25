import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 与 core 一致：固定东八区，避免「今天/昨天」用例在不同时区飘
    env: { TZ: 'Asia/Shanghai' },
  },
});
