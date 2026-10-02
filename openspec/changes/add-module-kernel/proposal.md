# Change Proposal: add-module-kernel

## 元信息

- **日期**: 2026-10-01
- **类型**: NEW（新建模块内核子系统）
- **状态**: proposed
- **影响 spec**: 新建 `module-kernel`；不改任何现有 spec
- **上游设计**: `docs/dsh-plugin-architecture.md`（§4 拆解设计）

## 动机（为什么做）

`AlysiaCore.start()`（`packages/core/src/index.ts:101-262`）**不是容器，是总装脚本**——
13 个步骤硬编码在一个方法里，零插件注册机制：

```
DB → LanceDB → embedService → llmService → MemoryManager → seedPersona
→ seedWorldbook → loadRolePackages → ProviderManager → ToolRegistry
→ CommandRegistry → Coalescer → Pipeline(7 stages) → EventBus
```

`packages/server/src/bootstrap.ts:28-322` 是第二个总装点，再叠 6 步（适配器 / Life / Proactive /
提醒 / cron / WebUI），且 **6 段巨型 systemPrompt 混在接线代码里**（`generateEvent` 那段 2000+ 字）。

后果：
- 新增/替换一个能力要改总装脚本，无法按需组合（`AlysiaFeatures` 的 4 个 flag 是硬编码分支）
- 生命周期不统一：`stop()` 只停 EventBus，其余资源各自处理
- 无法按能力做单测隔离
- **dsh 迁移无从下手**——dsh 是 cordis 插件体系，我们没有对应的装载单元（详见 `docs/dsh-plugin-architecture.md` §1：现有 dsh 集成已因机制换代而失效）

## 需求（做什么）

**本 change 只做内核，零侵入——不碰任何现有代码。**

- [ ] `Module` 契约（`name` / `inject` / `apply(ctx, config)`）
- [ ] `ModuleContext`（`get` / `provide` / `effect` / `on` / `emit` / `logger`）
- [ ] `ModuleHost`：拓扑排序 install、**逆序 dispose**、循环依赖检测、同名服务冲突检测
- [ ] 失败策略：`critical`（失败中止）/ `optional`（失败降级 + 记日志）
- [ ] 单测覆盖：拓扑排序 / 循环检测 / dispose 逆序 / effect 清理 / 冲突检测 / 降级路径

**明确不含**（后续 change）：
- 改写 `AlysiaCore.start()`（P1，`modularize-core-assembly`）
- 迁移现有模块（P2/P3）
- 提示词资产外置（P4）
- dsh 包装（二期）

## 设计决策（怎么做，含备选与取舍）

**决策 1：契约直接做成 cordis 形状，而不是自创风格**

备选是做一个朴素的 DI 容器（`register`/`resolve`）。否决原因：本拆解的**直接目的是 dsh 迁移**
（`docs/dsh-plugin-architecture.md` §5），契约形状越接近 cordis，二期包装越薄：

| 本项目 | cordis |
|---|---|
| `Module.apply(ctx, config)` | `export function apply(ctx, config)` |
| `Module.name` / `inject` / `Config` | `export const name` / `inject` / `Config` |
| `ctx.provide` / `get` | `ctx.set` / `ctx.foo` |
| `ctx.effect` | `ctx.effect`（**语义相同**：一切注册必须走它，否则卸载不回收） |

自创风格会让二期多写一层翻译层，且翻译层是 bug 温床。

**决策 2：`provide` 同名冲突 throw，不学 `ToolRegistry` 的静默覆盖**

`ToolRegistry.register`（`core/src/tools/registry.ts:48`）是 `Map` 同名覆盖——`bootstrap.ts:246`
就靠这个特性覆盖了 `index.ts:305` 注册的 reminder 工具（**这是现存的隐性行为，P1 必须保留**）。

但那是**工具**的语义（后者有意覆写前者）。**服务**不同：服务是依赖，同名冲突意味着两个模块
对同一个名字有不同的实现意图，静默覆盖会让依赖方拿到意料外的实例。
故 `provide` 冲突 **throw**，需要覆盖时显式 `ctx.override(name, value)`（本 change 不实现，
等真有需求再加——避免过早设计）。

**决策 3：`inject` 是声明式的，`get` 拿不到依赖 = 编程错误**

`inject: ['al:memory']` 声明后，宿主保证 install 时该服务已就绪。
`ctx.get()` 返回 `undefined` 时**不抛**（允许可选依赖探测），但 `apply` 内若声明了 `inject`
却拿不到，宿主在 install 前就 throw——错误提前暴露，而不是运行时 `undefined is not a function`。

**决策 4：失败策略由模块自声明，不由宿主猜**

`AlysiaCore.start()` 现有两处降级语义必须保留（P1 的验收基线）：
- LanceDB 失败 → `logger.warn` + `vectorStore = null` → 文本检索兜底（`index.ts:122-124`）
- `loadRolePackages` 失败 → 静默跳过（`index.ts:293`）

故模块声明 `critical: true`（默认，失败中止整树）或 `critical: false`（失败记 `logger.error`
并跳过，依赖它的模块收不到该服务）。**降级行为写在模块自己的 `apply` 里**，宿主只负责
「失败后不拖垮全树 + 记日志」这一层。

**决策 5：本 change 不接入任何调用方**

新增的 `kernel/` 目录不与现有代码产生任何 import 关系。P1 才接入。
这样 P0 的验收是纯粹的新增测试，**715 基线不可能被动摇**。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**无冲突**。`alysia-architecture` §2.2 原文「Stage 接口设计时预留
      细粒度拆分扩展点」——本 change 是该**设计意图的实现**（doc 已声明，impl 没接 → 改 impl）
- [x] 涉及 Web API？不涉及。内核不对外暴露任何 HTTP 面
- [x] 不修改 `docs/Web-API-Design.md`

## 风险

1. **过度设计**：`effect` / `on` / `emit` / 失败策略都可能用不上。
   缓解：P0 只做契约最小集，不做 HMR、不做热重载、不做配置 schema 校验（二期映射 cordis 时再补）。
2. **契约定错，P1 才发现**：`inject` 拓扑是否够用，要等 P1 拆 `al:memory`（依赖 4 个基础资源）
   才能验证。缓解：P0 的测试用**真实的 alysia 模块形状**做 fixture（db→memory 那条链），
   而不是抽象的 `A`→`B`。
3. **Coalescer ↔ EventBus 双向依赖**（`coalescer.ts:5` + `eventBus.put(priority)`）会在
   拓扑排序上形成环。缓解：本 change 的测试里**显式包含这个环的 fixture**，确定宿主的处理策略
   （允许声明为「互相依赖」并合并为一个模块）。这是 P1 的已知风险点，P0 要先给答案。

## 测试计划

- 单测 `packages/core/tests/kernel/`：
  - 拓扑排序：声明顺序打乱仍按依赖 install
  - 循环依赖：`A→B→A` throw 且报出环路径
  - dispose：**严格逆序**（含 async disposer）
  - `effect`：模块卸载时清理器全跑；单个抛错不影响其他
  - `provide` 冲突 throw
  - `inject` 未满足 → install 前 throw（不进入 apply）
  - `critical: false` 模块失败 → 不中止，依赖方拿不到服务
- 回归：**715 全绿**（本 change 不碰现有代码，应当天然全绿——这是决策 5 的目的）
- 环 fixture：用 Coalescer/EventBus 的真实形状验证宿主行为符合 P1 预期

## Apply 任务预览

新建 `openspec/specs/module-kernel/spec.md`；更新 `openspec/specs/index.md`。
