# Tasks: modularize-core-assembly

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 0. 先补安全网（P0 的结论被推翻）

- [x] ★ 核实：`grep -rln "AlysiaCore" packages/*/tests` → **无任何测试文件用它**。
      P0 完成时我说的「715 全绿是 P1 的安全网」是错的，`start()` 完全在测试盲区
- [x] 写 `packages/core/tests/index.smoke.test.ts`（11 用例）
- [x] **先在未改动的代码上跑绿**——才是真安全网（实测 9 passed）
- [x] 其中一条是真正的端到端：EventBus → scheduler → PII → memory-ingest → 落库
- [x] 补一条守住最微妙性质的断言：**Coalescer 在 `PipelineContext` 与 stage 列表里是同一实例**
      （拆成两个实例后管线照跑、打断静默失效、不报错——这种 bug 只能靠断言守）

## 1. 抽共享类型（解循环依赖）

- [x] `packages/core/src/options.ts`（新）：`AlysiaFeatures` + `AlysiaCoreOptions`
      —— `modules/` 要消费 `AlysiaFeatures`，从 `index.ts` 导入会成环
- [x] `index.ts` 原样 `export type` re-export（`import { AlysiaFeatures } from '@alysia/core'` 不变）
- [x] 核实无值导入：全仓只有 `import type` 用它

## 2. 模块（`packages/core/src/modules/`）

- [x] `resources.ts`：`al:db` / `al:vector` / `al:embed` / `al:memory-llm`
      - `al:vector` **保留原降级语义逐字**：失败 → `logger.warn`（不是 error）+ 提供 `null`
- [x] `memory.ts`：`al:memory` / `al:persona-seed`
      - `loadRolePackages` 的**静默跳过**语义原样保留（没"顺手"改成记日志）
- [x] `capabilities.ts`：`al:provider` / `al:tools` / `al:commands`
      - `registerChatTools`/`registerCodeTools` 抽成独立函数，模块与 `AlysiaCore` 公开方法共用
- [x] `loop.ts`：`al:eventbus` / `al:coalescer` / `al:pipeline` / `al:boot`
      - ★ `coalescer` 同一实例既进 `PipelineContext` 又作 stage
      - ★ `al:boot` 收 `scheduler.initialize()` + `eventBus.dispatch()`，
        `eventBus.stop()` 成为它的 `ctx.effect()`
- [x] `modules/index.ts` barrel

## 3. 改写 `AlysiaCore`

- [x] `start()` → 「`host.use(模块, 配置)` × 13 + `await host.start()` + 回填公开字段」
- [x] `stop()` → `host.stop()`（**不加新的清理动作**——proposal 决策 2）
- [x] `registerChatTools` / `registerCodeTools` 保留为公开方法（委托给共享函数）
- [x] 公开面**逐字不变**（server / scripts / console 无感）

## Apply 任务

- [x] `openspec/specs/module-kernel/spec.md` §5：标记 P1 已兑现
- [x] `openspec/specs/alysia-architecture/spec.md` §2.1 工程结构补 `kernel/` + `modules/`
- [x] `openspec/specs/index.md`：`module-kernel` 行更新
- [x] `docs/HANDOFF.md`：P1 完成 → 下一步 P2
- [x] 新建 `openspec/changes/modularize-core-assembly/spec.md`

## 验收结果（2026-10-01）

| 项 | 实测 |
|---|---|
| **冒烟测试** | ✅ **11 passed**（含端到端管线断言 + Coalescer 同一实例断言） |
| core | ✅ **566 passed**（P0 后 555 → +11） |
| server | ✅ **192 passed**（未动） |
| 全仓（除 E2E） | ✅ **818 passed**（70 files） |
| core tsc | ✅ 退出码 0 |
| server tsc | ✅ 退出码 0 |
| 源码改动面 | 只有 **`packages/core/src/index.ts`**（−280/+133 行）；其余全是新增 |

## ★ 真实 API 端到端验证（2026-10-01，`.env` 有 key）

补了 `tests/memory/e2e/core-turn.test.ts` 并**用真 DeepSeek + 智谱跑通完整一轮**：

```
用户: 用一句话回答：今天天气适合散步吗？不要调用任何工具。
昔涟: 人家没看过窗外的天气呢……不过要是你想出去走走，回来把风的味道讲给我听，
      就当人家也散过啦♪
```

这一轮覆盖了 smoke 碰不到的**检索 + LLM + Respond** 三段——正是 P1 改的装配：

| 链路 | 证明什么 |
|---|---|
| `[kernel] 已装载 13/13 个模块` | 拓扑排序 + 全部 install 成功 |
| persona 注入生效（回复是昔涟口吻） | `al:persona-seed` + prompt 组装 |
| 真实 embedding 检索 | `al:embed` + `al:vector` + `MemoryRetrievalStage` |
| 真实 LLM 回复并经 `event.send` 路由回来 | `al:provider` + `LLMAgentStage` + `RespondStage` |
| assistant 回复回写 EventLog | `llm-agent.ts:275-283` 链路 |

### E2E 结果（真 API）

| 文件 | 结果 |
|---|---|
| `core-turn.test.ts`（新增） | ✅ |
| `real-api.test.ts` | ✅ |
| `full-session.test.ts` | ✅ |
| `cron.test.ts` | ❌ **既有问题，非本 change 引入** |

**`cron.test.ts` 是既有失败的证据**（不靠推理，做了对照实验）：
把 `packages/core/src/index.ts` 用 `git checkout HEAD --` 还原成原版，**同一个测试一样失败**
（`expected '{}' not to be '{}'` at `cron.test.ts:80`），再还原回 P1 版本。
且该文件的 import 图只有 `MemoryManager` → stores/engines/processors，**不含 `src/index.ts`**。

→ 真问题是 **`CronProcessor` 的深度画像重写没有产出 `basics`**，与本 change 无关。
已记入 `HANDOFF.md` 待办，需要单开 change 排查。

## ★ 实现中途发现并修正的两件事

1. **测试结构缺陷**：冒烟测试原本把 `start()` 放在第一个 `it` 里，全量并行跑时 CPU 争抢
   让它超过 vitest 默认 5s 超时（实测 5278ms）→ `core` 未赋值 → 后续 5 个用例以
   `TypeError` 级联失败，**把真正的错因淹掉**。改为 `beforeAll` + 60s 超时。
   （首次观察到的「start() 从 1s 慢到 4.3s」是冷缓存假象，单跑只要 669ms。）
2. **`al:pipeline` 的 Coalescer 同一实例**：原实现里 `index.ts:242` 与 `:248` 传的是同一个
   `coalescer` 变量。拆模块时极易顺手 `new CoalescerStage()` 两次——**破坏了不会报错**，
   只是打断永久失效。已加断言守住。

## 遗留

- **`db.close()` / LanceDB 释放没做**（proposal 决策 2）：`stop()` 现在只经由 `al:boot`
  停 EventBus，与重构前行为一致。「生命周期不统一」这个已知问题仍开放，
  留独立 change `unify-core-shutdown`。
- **`al:memory-llm` 仍绕开 ProviderManager**（无超时/无 fallback/无 signal）——原样搬运，
  收编是独立 change。
- **`AlysiaCore` 不再支持 start → stop → start**（新 host 每次 start 建，但 `stop()` 后
  字段不回滚；原实现也没人这么做）。全仓无此用法。
- server 侧 `bootstrap.ts` 仍是总装脚本（P3 范围），**LifeService 的 6 段巨型 systemPrompt
  仍混在接线代码里**（P4 范围）。
