# Tasks: fix-next-dev-cross-origin

> 代码先落地（2026-10-03），本文件为 **2026-10-15 补立案**时回填。

## 实现任务

- [x] `packages/console/next.config.mjs` 增加 `allowedDevOrigins: ['127.0.0.1']`
- [x] 注释写清**症状 + 真实原因 + 曾经的误判**（"一整轮验证都是在 JS 被拦的状态下做的，
      还把现象归给了后端慢"）

## 验证任务

- [ ] `http://127.0.0.1:<port>` 打开 dev server → **JS chunk 不再被拦**，页面有交互 ← 需 `next dev` 运行
- [ ] `http://localhost:<port>` → 行为不变（无回归）
- [ ] **生产构建不受影响**：`pnpm build:console` 产物与改动前一致（该字段不进生产）

## Apply 任务

- [x] **无 spec 合并** —— 本 change 的 spec 增量为**空**（有意，见 proposal 设计决策 3：
  `allowedDevOrigins` 只影响 `next dev`，不进生产构建，不属产品契约）
- [x] 更新 `openspec/specs/index.md` 的 `alysia-console` 行（记账）
- [x] 归档到 `openspec/archive/2026-10-15-fix-next-dev-cross-origin/`

## 备注：本 change 明确不做

- **不排查 Next 16 还有哪些默认拦截** —— 只在被这个坑咬到时记录一处
- **不改 `dev` 之外的任何配置**
