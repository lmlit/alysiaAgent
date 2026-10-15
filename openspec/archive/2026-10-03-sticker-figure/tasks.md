# Tasks: sticker-figure

> 代码先落地（2026-10-03），本文件为 **2026-10-15 补立案**时回填。

## 实现任务

- [x] `xilian-figure.tsx` 重写为**表情包轮换**：`ROTATE_MS = 7000`、`FADE_MS = 500`
- [x] 拿到列表**立刻定下第一张**（不等第一个定时器间隔）
- [x] 轮换时随机挑**与当前不同**的一张；`stickers.length < 2` 时不轮换
- [x] 固定边长占位（`width = height`，表情包是正方形）→ 换图不引起布局跳动
- [x] 加载期**留空**（沿用 2026-09-25「占位符应当是同一个东西的粗糙版」的决定）
- [x] `prefers-reduced-motion` 监听：**照常轮换但不做淡入**
- [x] 可观测：`data-sticker={current ?? 'loading'}`（替代原 `data-live2d`）
- [x] root layout **移除 `Live2DLayer` 挂载**，改直接渲染 `{children}`
- [x] `lib/live2d/`、`components/live2d/` **一行未动**（保留回退能力，注释写明怎么回去）
- [x] 新增 `stickerApi.list()` + `stickerApi.fileUrl()`（`lib/api/modules.ts`）
- [x] 新增 `Sticker` / `StickersResponse` 类型（`lib/api/types.ts`）
- [x] `fileUrl` 走 `/api/stickers/file/:name`，**不用响应里的 `path`**，并在注释里钉住原因

## 验证任务

- [x] `npx tsc --noEmit` 干净
- [ ] 贴纸能显示（`/api/stickers/file/:name` → 200 且 content-type 是图片）← 需运行验证
- [ ] 等满 7s 至少换一次，且**不连续两次同一张** ← 需运行验证
- [ ] 单张贴纸时不轮换
- [ ] `prefers-reduced-motion: reduce` 下**仍轮换但无淡入**
- [ ] Network 面板确认**只请求当前一张**（不预载 65 张 ≈ 8MB）
- [ ] 贴纸 API 失败 → 页面不崩、静默留空（`data-sticker="loading"`）
- [ ] **Live2D 不再被预载**（移除挂载后不应再有 9MB 模型请求）

## Apply 任务

- [x] `alysia-console` §7.2 **改写**：Live2D → 表情包轮换（说明 Live2D 代码保留但未挂载）
- [x] `alysia-console` §7.2.1 / §7.2.2 标注「**保留但当前未启用**」（不是删除）
- [x] `alysia-console` §3 补贴纸两条路由
- [x] `docs/Web-API-Design.md` 校对 `/api/stickers` 与 `/api/stickers/file/:name` 是否在册
- [x] 更新 `openspec/specs/index.md`
- [x] 归档到 `openspec/archive/2026-10-15-sticker-figure/`

## 备注：本 change 明确不做

- **不删 Live2D 代码** —— 形象是主观选择，决策可能反复；删了要重写
- **不预取下一张** —— 注释留判据：「轮换变慢时再考虑」
- **不修 `console-a11y-motion` 的 17 处动画** —— 只处理本 change 自己引入的轮换淡入
- **不做表情包管理入口 / `[表情包:名字]` 渲染 / hero 随机策略** —— 全部归 `improve-sticker-system`
