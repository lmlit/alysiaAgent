import { defineConfig } from 'vitest/config';

/**
 * 根测试配置 — projects 形式（vitest 4）
 *
 * ★ 2026-09-24 修复：此前用 `vitest.workspace.ts` 声明多项目，但该文件在 vitest 4
 *   已不再被读取（projects 迁到 config 的 `test.projects`）。结果是根 `pnpm test`
 *   实际读的是本文件原来的 `include: tests/**`，而根目录没有 tests/ → 一直
 *   "No test files found" 空跑失败。这里改为 projects 声明。
 *
 * 各包仍可用 `pnpm --filter <pkg> test` 单独跑；core 的 e2e 用例需要 .env 里的
 * API key，按 HANDOFF 的约定用 `--exclude='tests/memory/e2e/*'` 跳过。
 */
export default defineConfig({
  test: {
    projects: [
      'packages/core/vitest.config.ts',
      'packages/server/vitest.config.ts',
      'packages/console/vitest.config.ts',
    ],
  },
});
