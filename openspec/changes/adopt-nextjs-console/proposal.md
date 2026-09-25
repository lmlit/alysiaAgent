# Change Proposal: adopt-nextjs-console

## 元信息

- **日期**: 2026-09-24
- **类型**: NEW（新前端系统）
- **状态**: proposed
- **影响 spec**: 新建 `alysia-console`（本 change 建立）；`webui-system` 本 change 不动，废弃另开 change

## 动机（为什么做）

现有 `packages/webui`（Vue 3 SPA）视觉质量被用户判定不合格——`webui-visual-redesign`
自 8-15 起就挂在"布局大改待确认"，一个多月没收敛。

用户改用 v0 生成了新前端 `Alysia-agent-view-main`（Next.js 16 + React 19 + Tailwind 4 + shadcn）。
经评审确认两点：

1. **设计系统完整**：oklch "暖墨"色板（暖炭灰底 + 单一暖金强调 `oklch(0.83 0.12 72)`）+ serif display
   字体层次（Instrument Serif / Inter）+ 4 个有语义的动效（breathe/float/shimmer/drift，
   全部服务于"她还活着"这一个表达）+ 纯 SVG 形象（`xilian-avatar.tsx`，不依赖 Live2D 资源就能立住）
2. **数据模型是照着 alysia 真实领域模型做的**，不是通用 demo：

   | 新前端 mock | 真实来源 | 匹配度 |
   |---|---|---|
   | `character.currentActivity / mood / intimacy` | `GET /api/life` → `getLifeSnapshot()` | 字段完全一致 |
   | `lifeEvents[].type = 'share' \| 'alone'` | `LifeEvent.type = 'chat' \| 'internal'` | 语义对应（8-29 life-event-message-split 的拆分），字段名需适配 |
   | `dailySummaries` | 每日摘要 | 语义对应 |
   | `companions` 在场/离场 | AI 生活配角机制 | 对应 |
   | `personalityDims` 3 维 × 4 参数 | `GET /api/persona` | 完全一致 |
   | `memoryKnobs` 5 个旋钮 | `memory_config` | 完全一致 |
   | `guardrails` 3 条 | PersonaAdapter 5 道护栏 | 对应 |
   | `userProfile` / `conversations` | `GET /api/profile` / `GET /api/sessions` | 对应 |

**用户决策（2026-09-24）**：以新前端为唯一前端载体，废弃 Vue 版；分步走，本 change 只做第一步
「收编 + 接只读真数据」。

## 需求（做什么）

**本 change 范围内**（第一步，只读）：

- [ ] 收编进 monorepo：`E:\workSpace\Alysia-agent-view-main` → `packages/console`（包名 `@alysia/console`），
      不带 v0 的 `.git`（无历史价值）
- [ ] **不打破现有构建**：确认新增 workspace 包后 `pnpm install --frozen-lockfile` 与
      `packages/server/Dockerfile` 仍可用（见风险 1）
- [ ] API 层：`lib/api/client.ts`（Bearer token + localStorage，迁自 `packages/webui/src/api/client.ts`，
      含 SSE 解析留作下一步）+ `lib/api/modules.ts`（按域分组）
- [ ] dev 代理：`next.config.mjs` rewrites `/api/*` → `http://127.0.0.1:6185`（照抄 vite 现有做法）
- [ ] 数据适配层 `lib/adapt.ts`：`{createdAt, type:'chat'|'internal', content}` →
      `{day, time, type:'share'|'alone', text}`（含 `delivered`、`origin` 语义保留）
- [ ] token 输入 UI（照搬 webui `App.vue`：未配置时提示输入并 persist 到 localStorage）
- [ ] 三页接真数据：`/dashboard`、`/life`、`/personality`
- [ ] 每页 loading / error 态（不含糊、不白屏）
- [ ] 不静默吞错：外部交互检查响应体 + 打日志（项目硬约束）

**明确不在本 change 内**（后续 change）：

- 聊天流式接入（`/api/chat/stream`）、写操作（人格调整 / 记忆旋钮 / 世界书增删）
- 管理能力补齐（世界书 / 知识库 / 角色 / 生活模板 / 审计 / 表情包）
- 静态导出 + Fastify 托管路径切换 + Docker 部署
- 废弃 `packages/webui`（含 Live2D 资产 / Electron 壳 / pet.html 迁移，见风险 2）

## 设计决策（怎么做，含备选与取舍）

**决策 1：收编进 `packages/console`，而非留在外部目录**

选前者——monorepo 单一事实源，`pnpm-workspace.yaml` 已声明 `packages/*`。代价是要处理 Docker 构建（风险 1）。

**决策 2：数据获取走客户端 fetch + localStorage token，而非 Next.js BFF route handlers**

选前者——与现有部署模型一致（webui 就是静态产物 + 同源 `/api` + localStorage token，见
`cr-p0-webui-auth`）。BFF 更安全（token 不进浏览器）但需要常驻 Node 运行时，
与"Fastify 同源托管静态产物"的单容器模型冲突，属于给个人工具引入额外运维成本。被否决。

**决策 3：新建 spec slug `alysia-console`，不改 `webui-system`**

选前者——Next.js 控制台是**新系统**（框架/架构/数据获取全不同），塞进 `webui-system` 会污染。
`webui-system` 保持有效直到废弃 change 真正删除 Vue 版。

**决策 4：本 change 只读，不碰 core/server 业务代码**

只读接入不需要服务端改动，把回归面压到最小。写操作放下一步。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**不冲突**——`webui-system` 描述 Vue 版现状，本 change 新建独立 spec，
      两者并存；废弃时再开 change 改 `webui-system`（方向：impl 删除 → 改 doc）
- [x] 涉及 Web API？**不涉及新接口**，只用既有 `GET /api/life`、`/api/profile`、`/api/persona`、
      `/api/sessions`、`/api/stats`。本 change 不改 `docs/Web-API-Design.md`
      （唯一缺口 `GET /api/platforms` 已在 backlog，不在本 change 范围）

## 风险与未决

1. ~~**Docker 构建可能被新包打破**~~ **→ 已实测解除（2026-09-24）**：模拟 Docker 构建上下文
   （只用 Dockerfile 会 COPY 的文件 + 完整 lockfile）跑 `pnpm install --frozen-lockfile`，
   输出 `Scope: all 3 workspace projects` + `Lockfile is up to date` —— pnpm 直接忽略缺失的
   `packages/console`，**Dockerfile 不需要改**。
   （附带发现：根 `packageManager` 是 pnpm@9.15.0，必须用 9.x 安装；用 pnpm 12 会改写 lockfile
   格式，破坏 Dockerfile 的 `--frozen-lockfile`。）
2. **"废掉 webui" 有三个真实约束**，不能直接删：
   - **Live2D 资产**：`packages/webui/public/models/cyrene/`（9.1MB，Cubism4，授权为"是依七哒署名，不可商用"）
   - **Electron 壳**：`packages/desktop` 加载该 SPA
   - **pet.html 桌宠页**（vite 多页入口）
   废弃 change 必须先决定这三块的去向。
3. **静态导出可行性**：当前 6 页全部 static prerender，理论上 `output: 'export'` 可行；
   但 `next/font/google` 与 `@vercel/analytics` 需验证，留到部署 change。

## 测试计划

- 本地起 server（6185）+ `next dev`（3000），三页显示真实数据，逐字段比对 `/api` 原始响应
- 无 token / server 未启动时，三页给出明确错误态（不白屏、不静默）
- `pnpm -r build` 全仓通过；core / server 测试不受影响（本 change 不碰其业务代码）
- 回归：确认 `packages/webui` 现有功能未被触碰
