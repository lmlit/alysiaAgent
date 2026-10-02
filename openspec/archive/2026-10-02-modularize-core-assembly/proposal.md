# Change Proposal: modularize-core-assembly

## 元信息

- **日期**: 2026-10-01
- **类型**: MODIFY（重构 `AlysiaCore.start()` 的装配方式，行为不变）
- **状态**: archived（2026-10-02 完成，2026-10-02 补归档；apply 已合并回 `openspec/specs/`）
- **影响 spec**: `module-kernel`（§5 验收基线兑现）、`alysia-architecture`（§2.2 扩展点）
- **上游**: `add-module-kernel`（P0）、`drop-kernel-peer`、`docs/dsh-plugin-architecture.md` §4.3

## 动机（为什么做）

`AlysiaCore.start()`（`packages/core/src/index.ts:101-262`）是 **13 步硬编码总装脚本**：
DB → LanceDB → embedService → llmService → MemoryManager → seed → roles → ProviderManager
→ ToolRegistry → CommandRegistry → Coalescer → Pipeline(7 stages) → EventBus。

新增/替换一个能力必须改这个方法；`AlysiaFeatures` 的 4 个 flag 是 if 分支；
生命周期不统一（`stop()` 只停 EventBus）；无法按能力隔离测试。

P0 已建好内核（`packages/core/src/kernel/`），本 change 把 `start()` 改成
「注册一批模块 + 跑 `ModuleHost`」。

## ★ 前置发现：`AlysiaCore` 此前没有任何测试覆盖

P0 完成时我说「715 全绿是 P1 的安全网」——**这是错的**。
`grep -rln "AlysiaCore" packages/*/tests` 显示：**没有任何测试文件用 AlysiaCore**。
`start()` 完全在测试盲区，「全绿」对 P1 毫无保护作用。

**故本 change 的第一件事是补安全网**（`tests/index.smoke.test.ts`，9 用例），
它先在**未改动的**代码上跑绿，再作为重构的验收依据。这与 `HANDOFF.md` 反复记的教训同源
（「成功日志掩盖了没做的事」）——**先确认安全网真的罩住了，再动刀**。

## 需求（做什么）

- [ ] `packages/core/src/modules/`：12 个模块，把 `start()` 的每一步搬进去
- [ ] `AlysiaCore.start()` → 「`host.use(模块, 配置)` × N + `await host.start()` + 回填公开字段」
- [ ] `AlysiaCore.stop()` → `host.stop()`（**行为保持**：仅 EventBus 停止，见「不做」）
- [ ] **公开面 100% 不变**（§验收基线）
- [ ] 冒烟测试保持全绿

### 模块清单与依赖

| 模块 | 来源 | inject | provides |
|---|---|---|---|
| `al:db` | `index.ts:103-106` | — | `al:db` |
| `al:vector` | `index.ts:110-124` | — | `al:vector`（**critical:false**） |
| `al:embed` | `index.ts:127-152` | — | `al:embed` |
| `al:memory-llm` | `index.ts:157-177` | — | `al:memory-llm` |
| `al:provider` | `index.ts:190-197` | — | `al:provider` |
| `al:eventbus` | `index.ts:256` | — | `al:eventbus` |
| `al:memory` | `index.ts:179` | db, vector, embed, memory-llm | `al:memory` |
| `al:coalescer` | `index.ts:232` | eventbus | `al:coalescer` |
| `al:persona-seed` | `index.ts:182-187` | memory | `false`（纯副作用） |
| `al:tools` | `index.ts:200-204` | memory, db | `al:tools` |
| `al:commands` | `index.ts:207-227` | memory | `al:commands` |
| `al:pipeline` | `index.ts:236-253` | memory, provider, tools, commands, coalescer | `al:pipeline` |
| `al:boot` | `index.ts:260-261` | pipeline, eventbus | `false`（纯副作用） |

依赖图是 **DAG**（`drop-kernel-peer` 已核实）：

```
层级0  db  vector  embed  memory-llm  provider  eventbus
层级1  memory ←(db,vector,embed,memory-llm)   coalescer ←(eventbus)
层级2  persona-seed / tools / commands  ←(memory)
层级3  pipeline ←(memory,provider,tools,commands,coalescer)
层级4  boot ←(pipeline,eventbus)   ← scheduler.initialize() + eventBus.dispatch()
```

## 设计决策

**决策 1：`al:boot` 独立成模块，而不是留在 `start()` 里**

`scheduler.initialize()` + `eventBus.dispatch()` 是「全部就绪之后」的启动动作。
放进模块后：① 顺序由 `inject` 保证，不靠调用位置；② `eventBus.stop()` 成为它的
`ctx.effect()`，生命周期闭环。

**决策 2：`stop()` 只做 `host.stop()`，但**不加**新的清理动作**

现状 `stop()` 只停 EventBus。改成 `host.stop()` 后，内核会**逆序 dispose 所有模块**——
目前只有 `al:boot` 注册了清理器（停 EventBus），其余模块没有清理器，所以**行为等价**。

⚠️ **刻意不在本 change 加 `db.close()` / LanceDB 释放**。那会修复「生命周期不统一」
这个已知问题，但它是**行为变更**，违反本 change「行为不变」的自我约束。
留作独立 change（`unify-core-shutdown`），到时可以单独验证。

**决策 3：`features` 由两个模块消费，不是一个带 if 的模块**

`codeMode` 决定 shell/file 工具。备选是 `al:tools` 里 `if (features.codeMode)`。
选定：仍放在 `al:tools` 内，但把 `registerChatTools` / `registerCodeTools` 抽成
可独立调用的函数（`AlysiaCore` 的公开方法也复用它们），这样两个模式各自可测。

**决策 4：模块配置文件化，不散落在 `start()`**

每个模块的配置（dbPath / workspaceDir / llmConfig / embedConfig / sampling / features）
由 `start()` 组装后 `host.use(module, config)` 传入。模块自己不读 `process.env`、不读全局。

## 对账方向确认

- [x] 与现有 spec 冲突？`module-kernel` §5 已提前写明 P1 必须保留的现存行为
      （LanceDB 降级、`loadRolePackages` 静默跳过、**`bootstrap.ts:246` 覆盖 `index.ts:305`
      reminder 工具**）。本 change 兑现它们，方向是 **docs → impl**
- [x] 涉及 Web API？不涉及。公开方法签名不变

## 风险

1. **`start()` 语义漂移**（异步顺序、降级路径）。缓解：冒烟测试 + 每个模块补单测。
2. **`bootstrap.ts:246` 覆盖 `index.ts:305` 的隐性行为丢失**。`ToolRegistry` 是 Map 同名覆盖，
   `bootstrap.ts` 在 `start()` 之后重新注册了 reminder 三件套。重构后 `al:tools` 仍先注册
   core 版本，`bootstrap` 仍后覆盖——**顺序不变**。冒烟测试锁定 core 版本可注册。
3. **`loadRolePackages` 的静默跳过语义**：它在 `try/catch` 里且 catch 为空。
   搬进 `al:persona-seed` 时保留原样（不"顺手改成记日志"——那是行为变更）。

## 测试计划

- **冒烟测试**（既有，`tests/index.smoke.test.ts`）：9 用例，重构前后都必须全绿
- **模块单测**（新增，`tests/modules/`）：每个模块的 apply 后效应用真实依赖验证
  （如 `al:tools` 注入 mock memory 后工具表正确）
- **降级路径**：`al:vector` 失败时 `al:memory` 仍装上且 vectorStore 为 null
- 回归：core + server + 全仓 projects 全绿
- 实测：跑一次 `packages/server` 的 CLI 路径（`scripts/recall-probe.ts` 之类）确认能起来
