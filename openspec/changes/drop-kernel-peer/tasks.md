# Tasks: drop-kernel-peer

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 核实（先做，再动手）

- [x] 读 `packages/core/src/eventbus/EventBus.ts` 全文（107 行）——**无一处提到 coalescer**
- [x] 读 `packages/core/src/pipeline/stages/coalescer.ts` 的 eventBus 引用——
      只有 `setEventBus()` setter + `coalescer.ts:185` 的 `eventBus.put()`
- [x] `grep -rn "coalescer" src/` 确认引用方向：`index.ts`（组装）、`pipeline/context.ts`、
      `pipeline/types.ts`、`llm-agent.ts`（消费）——**全是单向**
- [x] `bootstrap.ts:52` 的 `eventBus.setDefaultScheduler(scheduler)` 在 `start()` 之后，
      **不在构造期**——所以不构成构造期环
- [x] 结论：`al:eventbus`（无依赖）→ `al:coalescer` → `al:pipeline`，**严格 DAG**

## 实现任务

- [x] `packages/core/src/kernel/types.ts`：删 `Module.peer` 字段
- [x] `packages/core/src/kernel/host.ts`：
      - 删 `DisjointSet` 类 / `Unit` 接口 / `buildUnits()`
      - `topoSortUnits()` → `topoSort()`，**直接对模块拓扑排序**
      - `installOne(module, unitOf)` → `installOne(module)`，删「单元内 inject 不校验」分支
- [x] `packages/core/tests/kernel/fixtures.ts`：
      - 删 `eventbusModule`/`coalescerModule` 的 peer 版本
      - 新增真实单向链：`eventbusModule`（无依赖）/ `coalescerModule`（inject eventbus）/
        `pipelineModule`（inject coalescer）
      - ★ 每个模块在 `apply` 里断言**真的拿到了依赖**（拿不到就 throw），
        让 inject 契约被真实行使，而不只是被宿主检查
- [x] `packages/core/tests/kernel/host.test.ts`：
      - 删 4 个 peer 用例（对称性 / 不存在 / 成环不报错 / 延迟接线）
      - 新增 2 个：单向链按依赖顺序 + apply 内拿得到依赖；分叉依赖（提供者只装一次）
- [x] `packages/core/src/kernel/README.md`：删 peer 小节，改为「依赖必须是 DAG」+ 留档说明

## Apply 任务（spec 合并）

- [x] `openspec/specs/module-kernel/spec.md`：
      - §2.1 删 `peer` 字段
      - §2.4 从「双向依赖方案」改写为「**依赖图必须是 DAG**」+ **完整留档这次的错误**
        （依据未经验证 / 实际形状 / 教训 / 真出现环时的处置顺序）
      - §3 fixture 表：`coalescer ↔ eventbus` → `eventbus → coalescer → pipeline` + 分叉
      - §4「不做」表加一行：双向依赖 / peer
- [x] `docs/dsh-plugin-architecture.md`：
      - §3.4 更正「双向耦合」论断（保留对 PipelineScheduler 短路语义的真实依赖）
      - §4.2 模块表：`al:eventbus` 依赖从「pipeline, coalescer（双向）」改为「无」
      - §4.4 风险表：改写该条
- [x] `openspec/changes/add-module-kernel/` 的三个文件**保留原样**（那是当时的真实记录，
      不是要抹掉的历史）。本 change 的 proposal 里指明了被更正的具体断言。

## 验收结果（2026-10-01）

| 项 | 标准 | 实测 |
|---|---|---|
| 内核测试 | 全绿 | ✅ **32 passed**（原 34：删 4 个 peer，加 2 个链） |
| core 合计 | 557 → 555 | ✅ **555 passed**（−4 peer +2 链） |
| server | 不受影响 | ✅ **192 passed** |
| 全仓（root projects） | 全绿 | ✅ **807 passed**（69 files，含 console / dsh-adapter / dsh-console） |
| 类型检查 | 无错 | ✅ `tsc --noEmit` 退出码 0 |
| 现有代码改动 | 0 个 `.ts` | ✅ 只动了 kernel 自己 + 2 个文档 |

## 遗留

- ⚠️ `openspec/specs/module-kernel/spec.md` §2.4 的留档要长期保留——
  它是「凭什么删掉一个已实现且测试通过的机制」的唯一依据。archive 时不要精简掉。
