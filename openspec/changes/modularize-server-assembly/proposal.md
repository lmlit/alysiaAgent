# Change Proposal: modularize-server-assembly

## 元信息

- **日期**: 2026-10-01
- **类型**: MODIFY（重构 `bootstrap.ts` 的装配方式，行为不变）
- **状态**: proposed
- **影响 spec**: `module-kernel`（§5 验收基线）、`alysia-architecture`（§2.1 工程结构）
- **上游**: `modularize-core-assembly`（P1）、`add-module-tests`（P2）
- **设计依据**: `docs/dsh-plugin-architecture.md` §4.3 的 P3

## 动机（为什么做）

`packages/server/src/bootstrap.ts` 是**第二个总装脚本**——330 行里塞了：

配置加载 → core 构造/启动 → 三个 IM 适配器 → VisionBridge → ProactiveService
→ LifeService（**含 6 段巨型 systemPrompt，最长一段 2000+ 字**）→ 提醒推送
→ 6h cron → Fastify/WebUI → SIGINT/SIGTERM。

后果与 P1 之前一致：新增/替换能力要改总装脚本；生命周期散落（`stop()` 只清 cron + core）；
6 段提示词混在接线代码里（改一句话要读 330 行）。

## 需求（做什么）

把每一步搬进 `packages/server/src/modules/` 的模块，`bootstrap.ts` 退化为纯装配。

| 模块 | 来源 | inject | provides |
|---|---|---|---|
| `al:config` | dotenv + `loadConfig` + `IS_DESKTOP` | — | `al:config` |
| `al:logging` | `logger.configure` + 每日清理 | config | `al:logDir` |
| `al:core` | `AlysiaCore` 构造/start/`setDefaultScheduler` | config, logDir | `al:core` |
| `al:vision` | `VisionBridge` | config | `al:vision` |
| `al:adapters` | Telegram / OneBot / QQ 官方 | core, config, vision | **`al:push`** |
| `al:proactive` | `ProactiveService` | core, config, push | `al:proactive` |
| `al:life` | `LifeService` + 6 段提示词 | core, config, push, proactive | `false` |
| `al:reminder` | 提醒推送 + **工具同名覆盖** | core, push | `false` |
| `al:cron` | 6h `memory.cron()` + `archiveStaleSessions()` | core | `false` |
| `al:webui` | Fastify + console/webui 静态托管 | core, config | `false` |

## 设计决策

**决策 1：抽 `PushChannel`，把 life/proactive/reminder 从具体适配器上解耦**

它们**只用到一个方法** `sendProactive`，却各自持有整个 `QQOfficialAgentAdapter`。
抽成 `push.ts` 的 `PushChannel`（`available` + `sendProactive`）后：
- 三者可独立装配（P2 的模块测试铺路）
- 无通道时给 `NO_PUSH_CHANNEL`（`available: false`），消费方**跳过而不是拿到会炸的 undefined**
- 为 dsh 迁移扫清障碍（`docs/dsh-plugin-architecture.md` §4.2 的既定建议）

**决策 2：不注册停机 effect（Proactive / Life）**

原实现停机时**也没有**停它们（`stop()` 只清 cron + core）。
本 change 是**结构搬运**，不夹带行为变更——生命周期统一归 `unify-core-shutdown`。

**决策 3：`al:cron` 的 `clearInterval` 转成 effect**

这一条**是等价的**：原 `shutdown()` 里就清了它，现在改由 `host.stop()` 驱动，结果相同。

**决策 4：`staticDist` 的路径解析留在 `bootstrap.ts`**

原实现用 `dirname(fileURLToPath(import.meta.url))` 上溯两级定位 `packages/console/out`。
搬进 `src/modules/` 会**多一层上溯** → 指向 `packages/server/console/out`（不存在）
→ `existsSync` false → **静态路由静默不注册、SPA 白屏且无报错**。

这正是 `docs/dsh-migration-guide.md` **坑 #2** 的同类坑。故路径解析留在**知道自己在哪层**
的 `bootstrap.ts`，模块只收候选路径（用不用由它按 `isDesktop` 判）。

**决策 5：六段提示词原样搬运，提成模块常量（不外置）**

外置是 P4 的事。本 change 把它们从内联回调提成模块级 `const`，
**一个字都不改**——便于 `git diff` 逐字比对，也让 P4 只需搬文件不进逻辑。

## 对账方向确认

- [x] 与现有 spec 冲突？`module-kernel` §5 已列 P1 必须保留的行为；
      本 change 是 server 侧的对应工作，方向 **docs → impl**
- [x] 涉及 Web API？不涉及。公开端点、响应结构均未变（已用字节数比对验证）

## 测试计划

- 常规全仓 + E2E（真 API）
- 两个包 `tsc --noEmit`
- ★ **真启动服务并 curl 全部端点**，比对**响应字节数**与改造前一致
- ★ 启动日志逐行比对（除新增的宿主汇总行外应完全相同）
