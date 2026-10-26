# Tasks: console-a11y-motion

- [x] `packages/console/app/globals.css` 增加 `prefers-reduced-motion: reduce` 守卫
- [x] 关闭 4 个动画 token（breathe/float/shimmer/drift，共 17 处）
- [x] 全局 animation 时长压到 0.01ms、迭代 1 次
- [x] `pnpm build`（console）通过
- [x] 归档（随 `apply-decisions-2026-10-26` 同批）
