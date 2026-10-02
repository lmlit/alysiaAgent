# Spec: module-kernel（模块内核）

> ⚠️ **本文件是 propose 时的草案，已过时。** apply 后的 canonical 在
> `openspec/specs/module-kernel/spec.md`（已合并）。归档时以 canonical 为准。
> 草案 → 实现的差异（4 处，均为收紧而非漂移）：
> 1. 新增 `Module.provides` 字段（草案只写了「name 同时是服务名」）—— `inject` 提前校验与
>    重复检测需要静态声明；`false` 支持纯副作用模块（seed/cron）
> 2. `use(module, config?)` 加了第二参（草案是 `use(module)`）
> 3. §2.4 双向依赖**选定方案 A（peer 声明）**，被否决方案已删
> 4. `stop` 与启动失败回滚**都清空服务表**（草案只写了回滚；实现时被单测抓出
>    「回滚后仍报告幽灵服务」的 bug）
>
> 以下为草案原文，保留供追溯。

> 建立于 2026-10-01（change: add-module-kernel）。
> 父设计：`docs/dsh-plugin-architecture.md` §4.1。
> 本 spec 描述 alysia 内部的模块装载契约；**与 dsh 无关**（二期由 `dsh-adapter` spec 承接映射）。

## 1. 定位

`module-kernel` 是 alysia 的**装载内核**：把「能力」从总装脚本里解放出来，变成可声明、可组合、
可逆序卸载的 `Module`。

**它不做的事**：不解析配置文件、不做依赖注入的自动装配、不热重载、不做服务发现。
它只做三件事——**拓扑排序、安装、逆序卸载**。

### 1.1 要解决的问题

`AlysiaCore.start()`（`packages/core/src/index.ts:101-262`）目前是 13 步硬编码总装，
`packages/server/src/bootstrap.ts` 再叠 6 步。新增/替换能力必须改总装脚本，无法按需组合，
生命周期不统一，且无法按能力隔离单测。

### 1.2 与 cordis 的关系

契约**刻意做成 cordis 形状**，使二期包装成 dsh 插件时只需一层薄适配。

| 本项目 | cordis |
|---|---|
| `Module.apply(ctx, config)` | `export function apply(ctx, config)` |
| `Module.name` | `export const name` |
| `Module.inject` | `export const inject` |
| `Module.Config` | `export const Config` |
| `ctx.provide(name, value)` | `ctx.set(name, value)` |
| `ctx.get(name)` | `ctx.get(name)` / 声明 inject 后 `ctx.<name>` |
| `ctx.effect(setup)` | `ctx.effect(setup)`（**语义相同**） |
| `ctx.on/emit` | `ctx.on/emit` |

**不要**为了"更 TS"/"更显式"偏离这张表——偏离多少，二期翻译层就多厚多少。

## 2. 契约

### 2.1 Module

```ts
interface Module<S = unknown> {
  /** 模块名。同时是它的服务名（若它 provide 自己）。全局唯一，建议前缀 al: */
  readonly name: string
  /** 依赖的服务名。宿主保证 install 时已就绪 */
  readonly inject?: readonly string[]
  /** false = 失败不中止整树（默认 true）。降级逻辑写在 apply 内部 */
  readonly critical?: boolean
  /** 配置（本 change 不做 schema 校验；二期映射到 cordis Standard Schema） */
  readonly Config?: unknown
  apply(ctx: ModuleContext, config?: S): void | Promise<void>
}
```

**命名约定**：模块名用 `al:` 前缀（`al:db` / `al:memory`）。理由同 dsh——patch 的 id 索引是
全树扁平的，通用名（`memory` / `schedule`）会和出厂行撞名。

### 2.2 ModuleContext

```ts
interface ModuleContext<S = unknown> {
  /** 取服务。未注册返回 undefined（允许可选依赖探测） */
  get<T = unknown>(name: string): T | undefined
  /** 注册服务。同名冲突 → throw（不静默覆盖） */
  provide<T>(name: string, value: T): void
  /** 注册清理器。setup 立即执行，返回的函数在宿主 dispose 时调用 */
  effect(setup: () => (() => void | Promise<void>) | void, label?: string): void
  /** 模块间事件（非 pipeline 的 EventBus） */
  on(event: string, handler: (...args: unknown[]) => void): () => void
  emit(event: string, ...args: unknown[]): void
  readonly logger: Logger
  readonly config: S
}
```

**`effect` 是硬要求。** 一切注册（定时器、监听、文件句柄、子进程）必须走它。不走 →
模块卸载时不回收 → 泄漏 + 重复注册。这与 cordis 的 `ctx.effect()` 语义**逐字相同**。

**`provide` 冲突 throw 的理由**：服务是依赖，同名冲突意味着两个模块对同一个名字有不同的
实现意图，静默覆盖会让依赖方拿到意料外的实例。（`ToolRegistry` 的 Map 同名覆盖是**工具**的
语义——有意覆写——不适用于服务；且那是 `bootstrap.ts:246` 覆盖 `index.ts:305` 的现存隐性行为，
P1 迁移时必须保留，见 §5。）

**需要覆盖时**：显式调用（本 change 不实现 `ctx.override`，等真有需求再加，避免过早设计）。

### 2.3 ModuleHost

```ts
class ModuleHost {
  use(module: Module): this
  start(): Promise<void>
  stop(): Promise<void>
}
```

**`start()` 语义**
1. 拓扑排序（按 `inject`）。声明顺序不影响结果
2. **循环依赖 → throw，错误信息含环路径**
3. 逐个 install 前校验 `inject` 全部就绪；未满足 → **throw 且不调用该模块的 `apply`**
4. `critical: true` 模块 `apply` 抛错 → **中止整树**，已 install 的回滚
5. `critical: false` 模块 `apply` 抛错 → `logger.error` + 跳过；依赖它的模块随后因 inject 未满足而中止

**`stop()` 语义**
1. **严格逆序** dispose（后 install 的先销毁）
2. 每个模块先跑自己 `effect` 收集的清理器（**内部也逆序**），再跑模块级清理
3. disposer 可 async，全部 await
4. **单个 disposer 抛错不中断其他**，错误进 `logger.error`
5. 幂等：重复 `stop()` 不重复执行

### 2.4 双向依赖

`CoalescerStage` 与 `EventBus` 是真实的双向依赖——Coalescer 必须把合并事件
`eventBus.put(mergedEvent, {priority:true})` 重入管线（`coalescer.ts:177`），
而 EventBus 需要 Coalescer 提供的 `AbortRegistry`。

**本 change 必须给这个形状一个明确答案**，P1 依赖它。候选方案：

| 方案 | 说明 |
|---|---|
| **A. `peer` 声明** | 模块可声明 `peer: ['al:eventbus']`，宿主把互相 peer 的模块视为**同一安装单元**（同 install、同 dispose），不参与拓扑排序的外部依赖边 |
| B. 合并为一个模块 | `al:pipeline-loop` 同时含 Coalescer 和 EventBus |
| C. 延迟解析 | `ctx.get()` 在 `apply` 之后调用才解析（牺牲 §2.3 第 3 条的提前暴露） |

**倾向 A**：保住了模块边界（两者概念上确实不同），又不牺牲 fail-fast。
**B 是保底**——若 A 的实现复杂度超出预期，选 B 并在 spec 里写明理由。

*（apply 阶段必须回来把最终选定方案写进本节，删掉未选方案。）*

## 3. 单测要求

用**真实的 alysia 模块形状**做 fixture，不用抽象 `A`/`B`——否则契约正确性无法在 P1 兑现。

| fixture | 验证什么 |
|---|---|
| `al:db → al:memory` | 基础拓扑 + inject 就绪性 |
| `al:vector`（`critical:false`，apply 内抛错） | 降级路径：宿主不中止，依赖方收不到服务 |
| `coalescer ↔ eventbus` 成环 | §2.4 的双向依赖策略 |
| dispose 逆序 | 含 async disposer + 抛错 disposer |

## 4. 明确不做

| 不做 | 理由 |
|---|---|
| 配置 schema 校验 | 二期映射 cordis Standard Schema 时补 |
| HMR / 热重载 | dsh 有；alysia 是长驻进程，不需要 |
| 服务发现 / 自动装配 | 宿主只认显式 `use()` |
| `ctx.override` | 等真有需求再加 |
| scope / isolate / realm | 那是 dsh 的概念（`docs/dsh-plugin-architecture.md` §2.2）；alysia 是单进程单实例，不需要 |

## 5. 对现有代码的约束（P1 的验收基线）

本 change **零侵入**。P1（`modularize-core-assembly`）迁移时必须逐位保留的现存行为：

- LanceDB 失败 → `logger.warn` + `vectorStore = null` → 文本检索兜底（`index.ts:122-124`）
- `loadRolePackages` 失败 → 静默跳过（`index.ts:293`）
- **`bootstrap.ts:246` 覆盖 `index.ts:305` 的 reminder 工具**——这是 `ToolRegistry` Map 同名覆盖
  的隐性行为，迁移时必须保留（或显式记为一次 `override`）
- `AlysiaCore` 的公开面**不变**：`memoryManager` / `providerManager` / `toolRegistry` /
  `commandRegistry` / `eventBus` / `scheduler` / `coalescer` / `isGenerating()` /
  `registerPlatform()` / `registerChatTools()` / `registerCodeTools()` / `stop()`
  （server 与 console 依赖它们；console 对 core 是零 import，纯 HTTP）
