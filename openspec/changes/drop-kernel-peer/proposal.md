# Change Proposal: drop-kernel-peer

## 元信息

- **日期**: 2026-10-01
- **类型**: MODIFY（删掉 module-kernel 里一个无用户的机制）
- **状态**: proposed
- **影响 spec**: `module-kernel`（§2.1 / §2.3 / §2.4）
- **上游**: `add-module-kernel`（P0，同日完成）+ `docs/dsh-plugin-architecture.md`

## 动机（为什么做）

`add-module-kernel` 引入的 `Module.peer`（双向依赖合并为安装单元）机制，
**它的唯一依据是错的**。

propose 时我在 spec §2.4 写：

> `CoalescerStage` 与 `EventBus` 是真实的双向依赖——Coalescer 必须把合并事件
> `eventBus.put(mergedEvent, {priority:true})` 重入管线，而 **EventBus 需要 Coalescer
> 提供的 `AbortRegistry`**。两者形状上成环。

**后半句是我推断出来的，没验证。** 实际读完 `packages/core/src/eventbus/EventBus.ts`
（全文 107 行，无一处提到 coalescer）：

```
al:eventbus   ← 不依赖任何东西
al:coalescer  → al:eventbus      （coalescer.ts:185 的 eventBus.put）
al:pipeline   → al:coalescer     （llm-agent.ts:159 的 ctx.coalescer）
```

严格单向，**没有环**。`EventBus.setDefaultScheduler` 是 bootstrap 在 `start()` 之后接的线，
不在构造期。

于是 `peer` 没有用户。留着它有三个问题：

1. **违背本 change 自己的原则**——`add-module-kernel` proposal 决策 1 明写「避免过早设计」，
   decision 5 明写「P0 只做契约最小集」。一个没有用户的机制不在最小集里。
2. **违背本 change 的最高设计依据**——契约「刻意做成 cordis 形状，偏离多少二期翻译层就多厚多少」。
   **cordis 没有 peer 概念。** 留一个非 cordis 概念，等于给自己挖一层翻译成本。
3. **语义有陷阱**——peer 单元内 `inject` 不校验（先装的一方拿不到后装的），
   使用者必须延迟接线。这种微妙约定没有用户还留着，是纯粹的债务。

## 需求（做什么）

- [ ] 删 `Module.peer` 字段（`types.ts`）
- [ ] 删 `host.ts` 的 `DisjointSet` / `Unit` / `buildUnits()` / `topoSortUnits()` 的单元聚合逻辑，
      退回**直接对模块拓扑排序**
- [ ] 删 4 个 peer 相关测试 + fixtures 里的 `eventbusModule`/`coalescerModule`
- [ ] 把 fixture 换成**真实的**依赖形状：`al:eventbus → al:coalescer → al:pipeline`
      （单向链 + 一条分叉）
- [ ] spec §2.4 改写：从「双向依赖方案」改为「**核实后不存在双向依赖**」并留下核实过程
- [ ] `docs/dsh-plugin-architecture.md` §4.1 去掉 peer

**不改**：`ModuleHost` 的其余语义（声明式 inject、critical 降级、逆序 dispose、
provide 冲突 throw、stop 后拒绝注册）**全部保留**——它们有真实用户。

## 设计决策

**决策 1：删，而不是留作「以后可能有用」**

无用户的抽象在项目里有明确的负价值。这个项目的 `HANDOFF.md` 反复记录
「成功日志掩盖了没做的事」这类教训——留一个没用过的机制，下次有人看见它会以为它在被依赖，
或者照着它的微妙语义去用。删掉，需要时再加。

**决策 2：不做成「保留但在 spec 里标注未使用」**

标注未使用等于承认它是猜测性设计。要么有用户，要么不存在。

**决策 3：fixture 换成真实单向链，不删依赖形状的测试**

删掉 peer 不等于放弃「用真实模块形状做 fixture」这个原则。
换成 `al:eventbus → al:coalescer → al:pipeline`——这才是 alysia 实际的形状，
而且它测的是**同一个拓扑排序路径**，覆盖面不降。

## 对账方向确认

- [x] 与现有 spec 冲突？**本 change 就是在修 spec 的事实错误**。
      gap 方向：**docs → impl**？不——这里 doc 本身是错的（依据未经验证），
      所以是 **doc 修正**：删掉不成立的设计依据，并留下核实过程供追溯。
      区别在于：这不是「把 spec 降级迁就现状」，而是**纠正一个从未成立的事实断言**。
- [x] 涉及 Web API？不涉及。

## 风险

1. **万一 P1/P2/P3 真的出现环**——那时再加 `peer`（或选当时的方案 B：合并成一个模块）。
   删除不构成阻碍，因为**现在没有任何代码依赖它**。
2. **churn**：P0 刚验收完就改。缓解：改动是纯删除 + 测试替换，验收标准与 P0 相同（全绿）。

## 测试计划

- 删 4 个 peer 用例（对称性 / 不存在 / 成环不报错 / 延迟接线）
- 新增：三模块单向链拓扑（`al:eventbus → al:coalescer → al:pipeline`）+ 一条分叉
- 回归：**749 → 745 全绿**（core 553 + server 192）
- `tsc --noEmit` 退出码 0
