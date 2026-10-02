# Tasks: modularize-server-assembly

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 前置

- [x] `packages/core/package.json` 加 `"./kernel"` 导出（server 侧要用 `ModuleHost`）
- [x] `packages/server/src/push.ts`（新）：`PushChannel` 接口 + `NO_PUSH_CHANNEL`
- [x] `life.ts` / `proactive.ts`：`qqOff` 参数类型从具体适配器收窄为 `PushChannel`
      （两者都**只用** `sendProactive`）

## 模块（`packages/server/src/modules/`）

- [x] `config.ts`：dotenv + `loadConfig` + `IS_DESKTOP` → `al:config`
- [x] `logging.ts`：`logger.configure` + 每日清理 → **`al:logDir`**
- [x] `core.ts`：`AlysiaCore` 构造/start/`setDefaultScheduler`；`core.stop()` 转 effect
- [x] `vision.ts`：无 `embed.apiKey` 时**提供 undefined**（原语义就是整段跳过）
- [x] `adapters.ts`：Telegram / OneBot / QQ 官方；提供 **`al:push`**
- [x] `proactive.ts`：门不过时**提供 undefined**（`al:life` 要 `todayProactive()`）
- [x] `life.ts`：`LifeService` + 6 段提示词提成模块常量（**逐字未改**）
- [x] `reminder.ts`：★ **依赖同名覆盖**——`inject: ['al:core']` 保证 core 先注册 no-op 版
- [x] `cron.ts`：6h 定时；`clearInterval` 转 effect（与原 `shutdown()` 等价）
- [x] `webui.ts`：Fastify + 静态托管；`staticDist` 由外部传入（见 proposal 决策 4）
- [x] `index.ts` barrel（含依赖图注释）

## 重写 `bootstrap.ts`

- [x] 退化为「建 host + 注册 10 个模块 + `await host.start()` + 信号处理」
- [x] `consoleDist` 路径解析**留在本文件**（上溯层级在此处已知正确）
- [x] `main().catch` 顶层错误处理保留

## 验证

- [x] `tsc --noEmit`：core + server 均退出码 0
- [x] 常规全仓：**848 passed**
- [x] E2E（真 API）：**5 passed**
- [x] ★ **真启动服务 + curl 全部端点**
- [x] ★ 启动日志逐行比对；端点**响应字节数**比对

## Apply 任务

- [x] `openspec/specs/module-kernel/spec.md` §5 补 server 侧落实
- [x] `openspec/specs/alysia-architecture/spec.md` §2.1 补 server 模块目录
- [x] `openspec/specs/index.md` 更新
- [x] `docs/HANDOFF.md`：P3 完成 → 下一步 P4

## ★ 内核在启动时抓到的两个真装配错误

这次最值得记的：**两个错误都不是「跑起来才发现」，而是启动校验阶段就拒绝执行。**

1. `al:core` 声明 `inject: 'al:logging'`，但 `al:logging` 是 `provides: false`
   —— 内核直接报「没有任何模块声明 provides 它」。
   **根因是内核没有「只排序、不依赖服务」的表达方式**（见下）。
2. `al:adapters` 实际 `provide('al:push')` 却**没在 `provides` 里声明**
   —— 注入方 `al:proactive` 在校验阶段被拒。
   这正是 `provide` 白名单设计要抓的：声明与运行时不一致，在最早的时刻暴露。

**内核暴露出的能力缺口**：缺少「只排序、不依赖服务」的表达。
本项目用**能力令牌**绕过——`al:logging` 提供真值 `al:logDir`（日志目录），
`al:core` 注入它来表达「启动日志必须落进已配置的文件」。
若这种需求变多，应考虑给 `Module` 加 `after?: string[]`（本 change 不做，记入 `KNOWN-ISSUES`）。

## 验收结果（2026-10-01）

| 项 | 改造前 | 改造后 |
|---|---|---|
| 常规全仓 | 848 | ✅ **848**（未回归） |
| E2E（真 API） | 5/5 | ✅ **5/5** |
| core / server tsc | — | ✅ 均退出码 0 |
| **真启动** | 起来 | ✅ 起来，`已装载 13/13`（core）+ **`10/10`（server）** |
| 启动日志 | 基准 | ✅ **逐行相同**（仅多一行 server 宿主汇总） |
| `/api/life` | 14998 B | ✅ **14998 B** |
| `/api/profile` | 42752 B | ✅ **42752 B** |
| `/api/stats` | 1641 B | ✅ **1641 B** |
| `/api/sessions` | 787 B | ✅ **787 B** |
| `/api/persona` | 364 B | ✅ **364 B** |
| 源码改动面 | — | `bootstrap.ts` −317/+66；`life.ts` +3；`proactive.ts` +4 |
