# @alysia/console — 昔涟控制台

「昔涟」的前端（Next.js 16 + React 19 + Tailwind 4），取代 `packages/webui`（Vue，待废）。

契约见 `openspec/specs/alysia-console/spec.md`。

## 形态

| | 命令 | 说明 |
|---|---|---|
| 开发 | `pnpm dev:console`（根目录） | `next dev` on :3000，rewrites 代理 `/api` → 127.0.0.1:6185 |
| 生产 | `pnpm build:console` 后起 server | 静态导出到 `out/`，由 Fastify 同源托管（无代理、无 CORS） |

**构建依赖网络**：`next/font/google` 会下载字体并自托管为 woff2，离线构建会失败。

## 路由

`/`（landing）、`/dashboard`、`/chat`、`/life`、`/personality`

## 第三方资产

### Live2D 模型 — Cyrene

`public/models/cyrene/`（Cubism 4，21 文件）

> **模型来自 Cyrene-Agent，作者「是依七哒」。
> 授权个人使用 / 修改 / 再分发，要求署名，<ins>不可商用</ins>。**

运行依赖 `public/live2dcubismcore.min.js`（Live2D 官方 Cubism Core 运行时）。

### 其他

字体由 `next/font` 从 Google Fonts 拉取自托管；图标来自 `lucide-react`。
