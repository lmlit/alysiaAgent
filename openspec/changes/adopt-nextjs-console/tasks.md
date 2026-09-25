# Tasks: adopt-nextjs-console

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（subagent-driven-development / TDD），本文件只记账。

## 实现任务

### A. 收编

- [x] 拷 `E:\workSpace\Alysia-agent-view-main` → `packages/console`（不带 v0 的 `.git`、不带 node_modules）
- [x] `package.json` 改名 `@alysia/console`，与 monorepo 对齐（去掉自带 `packageManager`，根是 pnpm@9.15.0）
- [x] **验证不打破构建**：`pnpm install` + `pnpm -r build` 全仓通过
- [x] **验证 Dockerfile**：实测**不需要改**——模拟 Docker 构建上下文跑
      `pnpm install --frozen-lockfile` 输出 `Scope: all 3 workspace projects` + `Lockfile is up to date`，
      pnpm 直接忽略缺失的 `packages/console`（详见 proposal 风险 1）
- [x] `.gitignore` 确认 node_modules / .next / out / next-env.d.ts 被忽略

### B. API 层

- [x] `lib/api/client.ts`：Bearer token + localStorage（键 `webui_token`，与 webui 共用）
- [x] `lib/api/modules.ts`：`lifeApi` / `profileApi` / `personaApi` / `sessionApi` / `statsApi` / `sysApi`
- [x] `lib/api/types.ts`：**严格照 core 真实返回定义**（逐字段核对 MemoryManager/LifeStore/PersonaStore）
- [x] `next.config.mjs` rewrites：`/api/*` → `ALYSIA_API ?? http://127.0.0.1:6185`
- [x] token 输入 UI：`components/token-gate.tsx`（401 → 遮罩 → 存 token → 重载）
- [x] 去掉 v0 的 `typescript.ignoreBuildErrors: true`（会静默吞类型错误，与项目约束冲突）；实测类型干净
- [x] 移除 `@vercel/analytics`（自托管私人应用不应往 Vercel 发使用数据）

### C. 数据适配

- [x] `lib/adapt.ts`：LifeEvent 适配 + 相对日期/时钟/相对时间格式化
- [x] 人格三维度 / 雷达轴 / 记忆旋钮 / 画像 / 统计 适配
- [x] 适配层纯函数 + 单测（`tests/adapt.test.ts`，**36 个用例全过**）
- [x] 接 console 到 vitest（`vitest.config.ts`，TZ=Asia/Shanghai 与 core 一致）
- [x] ★ **修复根 `pnpm test` 空跑**：`vitest.workspace.ts` 在 vitest 4 已不被读取 →
      改根 `vitest.config.ts` 用 `test.projects`，删死文件。修复前 `No test files found`（exit 1），
      修复后发现 58 个文件 / 613 个用例

### D. 页面接真数据

- [x] `/life`：快照 hero + 7 天时间线 + 生活素材库（`/api/life/templates`，按 source 分种子/自创）
- [x] `/dashboard`：快照卡 + 事件流 + 画像 + 性格 + 统计（截断显示 `50+`）
- [x] `/personality`：真实 4/3/3 参数 + 雷达图（6 真实轴）+ 真实 5 旋钮 + overlay 演变记录
- [x] `/` landing：统计区接真实数据，读不到显示「—」不摆假数
- [x] `AppShell` 侧栏：真实生活快照 + 连接状态
- [x] 每页 loading / error / empty 态（`components/states.tsx`）
- [x] 未接入区块用 `NotWired` / `DemoBanner` 显式标注（`/chat` `/desktop` 全页标注）
- [x] 不静默吞错：网络失败 / 非 2xx / 非 JSON 三类都 console.error 后抛出

### E. 收尾

- [x] 手动验收：起 server(6185) + console(3000)，经代理逐接口比对真实响应
- [ ] ~~保留 mock 作为 `ALYSIA_MOCK=1` 回退~~ **未做（有意偏离）**：mock-data.ts 仍是
      `/chat` `/desktop` 的演示素材，再叠一层 env 开关只会增加 mock 泄漏进真实路径的风险；
      页面已有完整 error/empty 态，离线开发的诉求已覆盖
- [x] 未接部分界面显式标注（见上）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/alysia-console/spec.md`（新建目录）
- [x] 更新 `openspec/specs/index.md`（新增 `alysia-console` 行）
- [x] 在 `webui-system` 行标注「待废弃（见 adopt-nextjs-console）」
- [x] 更新 `docs/Web-API-Design.md`：标注这些端点已有新前端消费方
- [x] 运行测试验证（36 适配层用例 + 全仓 build + 根 workspace 发现正常）
- [x] 更新 `docs/HANDOFF.md`

## 验收记录（2026-09-24）

| 项 | 结果 |
|---|---|
| `pnpm -r build` | ✅ core / server / console / webui / desktop 全绿 |
| `pnpm --filter @alysia/console test` | ✅ 36 passed |
| 根 `pnpm test` 发现 | ✅ 58 文件 / 613 用例（修复前为 0） |
| `next dev` 6 路由 | ✅ 全 200 |
| 代理无 token | ✅ 401（服务端鉴权正确透传） |
| 代理带 token `/api/life` `/api/persona` `/api/profile` `/api/sessions` `/api/stats` | ✅ 真实 JSON，字段与类型定义一致 |

**⚠️ 验收时发现的既有事实（非本 change 引入）**：本地实例的生活快照 `updatedAt` 停在
**2026-09-03**，`/api/life` 的 `events` 为空 —— 本地实例自 9-03 起没跑过，她的生活状态是 21 天前的。
正好验证了 empty 态。服务器容器的状态需另行确认（见 HANDOFF 待观察项）。

## 待后续 change

1. **补两个只读端点**：`/api/life/summaries`（`LifeStore.getRecentSummaries`）、
   `/api/life/companions`（`listScenePresence`）—— core 已有方法，只差路由 + 契约文档
2. 聊天流式接入（`/api/chat/stream`）+ 会话列表
3. 管理能力补齐（世界书 / 知识库 / 角色 / 生活模板编辑 / 审计）
4. 静态导出 + Fastify 托管切换 + Docker 部署
5. 废弃 `packages/webui`（先安置 Live2D 资产 / Electron 壳 / pet.html）
