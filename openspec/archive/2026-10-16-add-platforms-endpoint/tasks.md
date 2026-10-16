# Tasks: add-platforms-endpoint

> backlog 项落地（2026-10-16）。**口径在实现时被收敛过**，见 proposal 的决策 1 —— 那是本 change 最值钱的部分。

## 实现任务

- [x] `EventBus.listSchedulers(): Array<{ name, scheduler }>` —— 平台注册表的**只读快照**
      （为什么带 `scheduler`：区分「默认调度器」与「专属调度器」的判断**只有这里知道**，
      兜底 `scheduler ?? this.scheduler` 发生在本类之外）
- [x] `AlysiaCore.getPlatformStatus()` —— 按 `docs/Web-API-Design.md` §3.4 的契约名实现
- [x] server 路由 `GET /api/platforms`（`webui/server.ts`）
- [x] `docs/Web-API-Design.md`：状态标记 `⬜ 未实现` → **`🟢 core 已封装`**；
      §3.4 补返回值形状 + **口径收敛说明**

## ⚠️ 口径收敛（实现时定，必须留档）

原 §3.4 写「各 adapter 的**连接状态**」。实现时确认 **core 看不到连接层**：

| 想报的 | core 知道吗 |
|---|---|
| 哪些平台 scope 注册过 | ✅ 知道（`registerPlatform`） |
| WebSocket 是否连着 / 上次心跳 | ❌ 不知道 —— 属 adapter 运行时状态 |
| 上次收到消息的时间 | ❌ 不知道 |

三个适配器**都没有暴露**连接状态。⇒ 本 change **只报 core 知道的**，
**不编造** `connected: true` / `lastHeartbeat`。理由：假字段比没有字段更糟 ——
Web 端会把它当真，而它永远恒为真（与「存活指标骗过一次 22 天全绿」同一类错误）。

**已接入 ≠ 连通**：返回里有名字只说明装配期注册成功。

## 测试

| 层 | 落点 | 覆盖 |
|---|---|---|
| core | `tests/platform-status.test.ts`（新，3 例） | 空列表不抛；注册后出现且排序；`default`/`custom` 可区分；**快照只读**（改返回值不影响后续） |
| server | `tests/webui-platforms.test.ts`（新，3 例） | 透传；空列表不是 null；**刻意断言"没有"** `connected`/`lastHeartbeat`/`lastMessageAt` |

## Apply 任务

- [x] A.1 `docs/Web-API-Design.md`（状态标记 + §3.4 形状 + 口径收敛）
- [x] A.2 更新 `openspec/specs/index.md`？——**不需要**：本项无独立 spec
      （属 `Web-API-Design.md`），故不动 spec 索引
- [x] A.3 运行测试（见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| core 定向 | `run tests/platform-status.test.ts`（`packages/core`） | **3 passed** |
| server 定向 | `npx vitest run tests/webui-platforms.test.ts`（`packages/server`） | **3 passed** |
| 类型 | `npx tsc --noEmit`（core / server） | 两者 exit 0 |

⚠️ **构建依赖顺序**（本仓踩过两次）：server 编译吃的是 **core 的 `dist`** ——
改了 core 的公开面后**必须先 `packages/core` 下 `npx tsc`**，否则 server 侧 tsc 报
`Property 'getPlatformStatus' does not exist`。

## 部署状态

**未部署。** 需要 core 构建 + server 重启才生效（console 若要用，另需前端构建）。
