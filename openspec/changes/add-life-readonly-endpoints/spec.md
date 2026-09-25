# Spec: alysia-console（昔涟控制台 · Next.js）

> 建立于 2026-09-24（change: adopt-nextjs-console）。
> 本 spec 取代 `webui-system` 的定位，但**在废弃 change 落地前两者并存**——
> `webui-system` 描述 Vue 版现状，本 spec 描述新前端契约。

## 1. 形态

Next.js 16 + React 19 + Tailwind 4 + shadcn，`packages/console/`（包名 `@alysia/console`）。

**两种形态互斥**（`output:'export'` 下 rewrites 不生效，故按 `NODE_ENV` 切换）：

- **开发**：`next dev`（3000），`next.config.mjs` 的 `rewrites` 代理 `/api/*` →
  `ALYSIA_API ?? http://127.0.0.1:6185`（照抄 webui 的 vite proxy 约定）
- **生产**：`next build` → `output: 'export'` → `out/` 静态产物，
  **由 server Fastify 同源托管**，与 `/api/*` 共用一个端口（默认 6185），无代理、无 CORS

路由：`/`（landing）、`/dashboard`、`/chat`、`/life`、`/personality`、`/desktop`。
产物结构为多页 `.html`（`out/life.html`，**非** `life/index.html`）。

**构建依赖网络**：`next/font/google` 在构建时下载字体并自托管为 woff2
（实测 11 个），离线构建会失败。

**远端部署（2026-09-25, deploy-console-remote）**：`out/` 由 `packages/server/Dockerfile`
的 runtime 阶段 `COPY` 进镜像（**不在 Docker 里构建**——`next build` 要联网下字体，
alpine 里既慢又脆），容器内路径 `/app/packages/console/out`。
发版前必须先 `pnpm build:console`——`out/` 是构建产物且不进 git。
容器内保持 `0.0.0.0` + 强制鉴权（不套用本机的回环配置）。

## 2. 设计系统

单一事实源 `app/globals.css`，oklch "暖墨"（Warm ink）色板：

- 背景 `oklch(0.17 0.014 55)` 暖炭灰（**非纯黑**）；卡片 `oklch(0.215 0.016 58)`
- primary 暖金 `oklch(0.83 0.12 72)`（**唯一强调色**）；accent 珊瑚橘 `oklch(0.72 0.13 24)`
- 字体层次：display = Instrument Serif（serif），body = Inter（sans）
- 动效仅 4 个，且均有语义（表达"她还活着"）：`breathe`（呼吸）/ `float`（漂浮）/
  `shimmer`（文字流光）/ `drift`（光斑漂移）
- 形象 `xilian-avatar.tsx`：纯 SVG 暖光球（core 径向渐变 + halo + 环形虚线 + 漂浮粒子），
  **不依赖 Live2D 资源**，作为 Live2D 不可用时的保底形象

禁止引入：霓虹 glow 阴影、多色强调、无意义动画。

## 3. API 接入

- `lib/api/client.ts`：`api.get/post/del` + `ApiError(status)`；Bearer token 存 localStorage
  （键 `webui_token`，与 `webui-system` 一致，见 `cr-p0-webui-auth`）
- `lib/api/modules.ts`：按域分组（`lifeApi` / `profileApi` / `personaApi` / `sessionApi` /
  `statsApi` / `sysApi`），端点对应 `docs/Web-API-Design.md`
- **token 从不写入仓库**；未配置时界面提示输入，不静默 401

## 4. 数据适配层

`lib/adapt.ts` 纯函数，**唯一允许做字段翻译的地方**：

| 源（core） | 目标（视图） | 规则 |
|---|---|---|
| `LifeEvent.createdAt` (ISO) | `{day, time}` | 今天 / 昨天 / `M月D日` + `HH:mm` |
| `LifeEvent.type` `'chat'` | `'share'`（主动分享） | 推送对轻月说的话 |
| `LifeEvent.type` `'internal'` | `'alone'`（独处时光） | 生活叙述，只入库 |
| `LifeEvent.content` | `text` | 原样 |

保留 `delivered` / `origin` 字段——`origin: 'followup'`（对话余波，不推送）在视图上应可区分。

**中文标签沿用 webui**（`PersonaView.vue`），两个前端叫法必须一致：

| 域 | 真实键（**以 core 为准**） | 中文 |
|---|---|---|
| tone | formality / warmth / humor / directness | 正式度 / 温暖度 / 幽默感 / 直接度 |
| speechStyle | sentence_length / emoji_usage / code_heavy | 句子长度 / 表情使用 / 代码倾向 |
| emotionalRange | expressiveness / empathy / playfulness | 表达力 / 共情力 / 俏皮度 |
| memoryConfig | decay_rate / importance_threshold / recency_weight / confirmation_bias / retention_bias | 遗忘速度 / 重要阈值 / 近期权重 / 固执度 / 正负偏向 |

> ★ **mock 臆造字段登记**：`lib/mock-data.ts` 的 `personalityDims` 给说话风格和情感范围各编了
> 第 4 个参数（口语化 / 稳定性），`memoryKnobs` 编了「情绪记忆 / 主动唤起」两个旋钮。
> 这些**在 core 里不存在**。视图一律以真实键驱动；未知键原样显示不隐藏（不静默丢数据）。

适配层必须有单测，覆盖空数组 / 非法时间 / 未知 type / 缺键 / null。
服务端 limit 截断（`GET /api/sessions` 是 `listSessions(50)`）必须在展示上体现
（拿满 50 条显示 `50+` 而非假装是全部）。

## 5. 页面契约（本 change 范围）

**已接入真实数据**：

- `/life`：hero（当前活动 / 心情 / 心情注释 / 亲密度 / 状态更新时间）+ 7 天事件时间线 +
  每日生活摘要（`/api/life/summaries`）+ 她的世界·配角在场（`/api/life/companions`）+
  生活素材库（`/api/life/templates`，按 `source` 分「种子活动 / 她自创的」）
- `/dashboard`：life 快照卡 + 事件流 + 画像（`/api/profile`）+ 性格参数（`/api/persona`）+
  统计（`/api/sessions` + `/api/stats`）+ 她的世界（配角在场）
- `/personality`：3 维参数真实值（**4/3/3，非 mock 的 4/4/4**）+ 雷达图（6 个真实轴）+
  记忆旋钮（**真实 5 个**）+ overlay 演变记录（`overlayNotes`）
- `/`（landing）：统计区走真实数据，读不到显示「—」而不是假数字
- `AppShell` 侧栏：真实生活快照（活动 / 心情 / 在线状态随请求结果变化）
- 每页均有 loading / error / empty 态（`components/states.tsx`），**不得白屏**

> 每日摘要与配角在场两个端点由 `add-life-readonly-endpoints`（2026-09-25）补上——
> 此前 core 有方法但无路由，页面只能标「未接入」。

**显式标注为未接入**（`components/states.tsx` 的 `NotWired` / `components/demo-banner.tsx`）：

| 区块 | 原因 |
|---|---|
| 护栏实时状态 | 护栏在 PersonaAdapter 内部，无查询接口（页面展示的是设计约束本身） |
| `/chat` 全部 | 未接 `/api/chat/stream`（流式对接见后续 change） |
| `/desktop` 全部 | 形态预览页，数据为样例 |

## 6. 错误处理（项目硬约束）

- 外部交互必须检查响应体并打日志，**禁止静默吞错**（`lib/api/client.ts` 统一处理：
  网络失败 / 非 2xx / 非 JSON 三类都 `console.error` 后抛出）
- 未接入的页面/区块必须在界面上显式标注，**不得用 mock 冒充真数据**
- 401 → `TokenGate` 遮罩要求输入 token（`components/token-gate.tsx`）
- 401 与网络失败是两回事：前者弹遮罩，后者进页面 error 态

## 6.1 测试

- `packages/console/vitest.config.ts`，`tests/adapt.test.ts` 覆盖适配层纯函数
- 根 `vitest.config.ts` 用 vitest 4 的 `test.projects` 声明三个包
  （★ 2026-09-24 修复：此前 `vitest.workspace.ts` 在 vitest 4 已不被读取，根 `pnpm test` 空跑失败）

## 7. 服务端静态托管契约（2026-09-24, console-local-serve）

`createWebuiApp(core, { staticDist })` 托管前端产物；不传 `staticDist` 时用默认
（`packages/webui/dist`）。**由 `bootstrap.ts` 决策**：

| 模式 | 托管 | 理由 |
|---|---|---|
| 服务模式（非 `ALYSIA_DESKTOP`） | `packages/console/out`（存在时） | 新前端是服务端门面 |
| 桌面模式（`ALYSIA_DESKTOP=1`） | `packages/webui/dist` | Electron 壳依赖 webui 的 hash 路由 / Live2D / pet.html |
| `out/` 不存在 | 回退 `webui/dist` + 日志说明 | 「没构建也能用」，不 500 |

**路径映射（两种前端形态不同，用候选链统一）**：

1. 原路径（静态资源命中）
2. `<path>.html` —— Next 静态导出（`/life` → `life.html`）
3. `<path>/index.html` —— 目录形式（兼容 `trailingSlash` 构建）
4. 都没中：有 `404.html` 用它且**状态码 404**（Next）；否则回退 `index.html` 且 200（webui hash 路由）

首尾斜杠都要剥（`/life/` 必须命中 `life.html`）。防目录穿越用 `dist + sep` 收口。
MIME 需覆盖 `woff2`（自托管字体）与 `txt`（Next RSC payload）。

## 7.1 鉴权边界（★ 2026-09-24 修复）

鉴权钩子**只守 `/api/*`**，静态资源与页面公开。

原实现拦下**所有**请求，与自身文档注释（"所有 `/api/*` 校验"）不符——浏览器导航到 `/`
无法携带 `Authorization` 头，会拿 401，**前端页面根本加载不出来**。旧前端未暴露此问题：
本地走 vite dev（静态文件不由 Fastify 出），Docker 镜像里又没打包 dist。

`/api/health` 豁免，且**带 query 也要豁免**（`/api/health?probe=1`）。

**触发条件（★ 9-25 server-bind-host）**：要不要鉴权**跟随绑定地址**——
绑定回环（`127.x`/`localhost`/`::1`）⇒ 仅本机可达 ⇒ 免鉴权，打开就能用；
绑定对外地址 ⇒ 强制鉴权。本地只绑回环：config.yml 写 `server.host: "127.0.0.1"`。
详见 `server-hardening` §6。

## 8. 与 webui-system 的关系

- 两者并存，直到废弃 change 落地
- 共享：`/api/*` 端点、Bearer token 键名、同源部署模式
- 不共享：框架、主题 token（本 spec §2 vs `webui-system` §2 `--aw-*`）、组件池
- **待办（后续 change）**：Live2D 资产（`models/cyrene/`，授权"是依七哒署名，不可商用"）、
  Electron 壳（`packages/desktop`）、`pet.html` 桌宠的迁移或废弃决策
