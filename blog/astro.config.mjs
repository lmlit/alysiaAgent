// 昔涟的博客 —— 构建配置
//
// ⚠️ **base 是硬要求**：它挂在基站的 `/p/alysia-blog/` 子路径下，
//    不设 base 的话所有以 `/` 开头的资源都会 404（2026-10-20 迁移时踩过）。
import { defineConfig } from 'astro/config';

export default defineConfig({
  // ⚠️ **故意不写 `site`**：它要填完整域名（含 IP），而本仓是公开的 ——
  //    base 已经足够让资源走对路径；canonical/sitemap 由基站那侧决定。
  base: '/p/alysia-blog',
  outDir: './dist',
  // 静态站：不要 trailingSlash 造成 /essays/x/ 与 /essays/x 两份
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
