---
status: active
source: （无旧文档，2026-10-01 change: add-module-kernel）
---
# Spec: module-kernel（模块内核）

> 建立于 2026-10-01（change: add-module-kernel）。
> 父设计：`docs/dsh-plugin-architecture.md` §4.1。
> 本 spec 描述 alysia 内部的模块装载契约；**与 dsh 无关**（二期由 `dsh-adapter` spec 承接映射）。
> 代码：`packages/core/src/kernel/`（含 README 速查）。

## 1. 定位

`module-kernel` 是 alysia 的**装载内核**：把「能力」从总装脚本里解放出来，变成可声明、可组合、
可逆序卸载的 `Module`。

**它不做的事**：不解析配置文件、不做依赖注入的自动装配、不热重载、不做服务发现。
它只做三件事——**拓扑排序、安装、逆序卸载**。

### 1.1 要解决的问题

`AlysiaCore.start()`（`packages/core/src/index.ts:101-262`）目前是 13 步硬编码总装，
`packages/server/src/bootstrap.ts:28-322` 再叠 6 步。新增/替换能力必须改总装脚本，无法按需组合，
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
  /** 模块名。同时是它的服务名（除非显式声明 provides）。全局唯一，建议前缀 al: */
  readonly name: string
  /** 依赖的服务名。宿主保证 install 时已就绪（peer 单元内的除外，见 §2.4） */
  readonly inject?: readonly string[]
  /** 将提供的服务名。undefined → [name]；false → 不提供（纯副作用模块）；数组 → 显式 */
  readonly provides?: readonly string[] | false
  /** false = apply 失败不中止整树（默认 true）。降级逻辑写在 apply 内部 */
  readonly critical?: boolean
  /** 配置（本 change 不做 schema 校验；二期映射到 cordis Standard Schema） */
  readonly Config?: unknown
  apply(ctx: ModuleContext<S>, config?: S): void | Promise<void>
}
```

**命名约定**：模块名用 `al:` 前缀（`al:db` / `al:memory`）。理由同 dsh——patch 的 id 索引是
全树扁平的，通用名（`memory` / `schedule`）会和出厂行撞名。

### 2.2 ModuleContext

```ts
interface ModuleContext<S = unknown> {
  readonly name: string
  /** 取服务。未注册返回 undefined（允许可选依赖探测） */
  get<T = unknown>(name: string): T | undefined
  /** 注册服务。同名冲突 → throw。只能 provide 本模块 provides 声明过的名字 */
  provide<T>(name: string, value: T): void
  /** 注册清理器。setup 立即执行；返回值在宿主 dispose 时调用 */
  effect(setup: () => (() => void | Promise<void>) | void, label?: string): void
  /** 订阅模块间事件。返回取消订阅函数（同时自动登记为 effect） */
  on(event: string, handler: (...args: unknown[]) => void): () => void
  /** 发布模块间事件。单个 handler 抛错不中断其他（错误进日志） */
  emit(event: string, ...args: unknown[]): void
  readonly logger: ModuleLogger
  readonly config: S
}
```

**`effect` 是硬要求。** 一切注册（定时器、监听、文件句柄、子进程）必须走它。不走 →
模块卸载时不回收 → 泄漏 + 重复注册。这与 cordis 的 `ctx.effect()` 语义**逐字相同**。

**`provide` 冲突 throw 的理由**：服务是依赖，同名冲突意味着两个模块对同一个名字有不同的
实现意图，静默覆盖会让依赖方拿到意料外的实例。（`ToolRegistry` 的 Map 同名覆盖是**工具**的
语义——有意覆写——不适用于服务。）

**`provide` 白名单**：只能 provide `Module.provides` 声明过的名字。防拼写错误——
声明与运行时不一致会在最早的时刻暴露，而不是等依赖方 `undefined`。

**stop 之后** `effect` / `on` / `provide` 一律 throw（对应 cordis 的 `INACTIVE_EFFECT`）。

**需要覆盖服务时**：本 change 不提供 `ctx.override`，等真有需求再加（避免过早设计）。

### 2.3 ModuleHost

```ts
class ModuleHost {
  constructor(opts?: { logger?: ModuleLogger })
  use(module: Module, config?: unknown): this
  get<T = unknown>(name: string): T | undefined
  has(name: string): boolean
  start(): Promise<void>
  stop(): Promise<void>
}
```

**`use()` 的静态检查**（立刻抛错，不等 `start()`）
- 模块名重复
- 两个模块声明同一个服务名

**`start()` 语义**
1. 静态校验：每个 `inject` 名都必须有模块声明过 `provides`
2. 按 `inject` 拓扑排序。**声明顺序不影响结果**
3. **循环依赖 → throw，错误信息含完整环路径**（`al:a → al:b → al:c → al:a`）
4. 逐个 install 前校验 `inject` 全部就绪；未满足 → **throw 且不调用该模块的 `apply`**
   （错误信息点出提供者模块名）
5. `critical: true`（默认）模块 `apply` 抛错 → **中止整树**，已装的**逆序回滚 + 清空服务表**
6. `critical: false` 模块 `apply` 抛错 → `logger.error` + **把它声明的服务登记为 `undefined`**，
   继续装后续模块。依赖方拿到 `undefined`（降级值）而不是整体中止

> 第 6 条正是 alysia 现有语义：LanceDB 失败 → `vectorStore = null` → 文本检索兜底
> （`index.ts:122-124`）。

**`stop()` 语义**
1. **严格逆序** dispose（后 install 的先销毁）
2. 每个模块**逆序**跑自己 `effect` 收集的清理器
3. disposer 可 async，全部 await
4. **单个 disposer 抛错不中断其他**，错误进 `logger.error`
5. 幂等：重复 `stop()` 不重复执行
6. stop 后 `use` / `start` 一律 throw（**不支持重启，需要新实例**）

### 2.4 依赖图必须是 DAG（不做双向依赖）

宿主**不做**任何环的特殊处理：**有环就是配置错误，直接抛错并报出环路径。**

> ⚠️ **曾经做错过，留档。** `add-module-kernel` 一度实现了 `Module.peer`（把互相 peer 的
> 模块合并为同一安装单元），依据是「`CoalescerStage` ↔ `EventBus` 是真实双向依赖」。
> **那个依据从未被验证，而且是错的**：`EventBus.ts`（107 行）**全文不引用 Coalescer**，
> `setDefaultScheduler` 是 `bootstrap.ts:52` 在 `start()` 之后接的线，不在构造期。
> 已于 `drop-kernel-peer` 删除。
>
> 教训：**「我觉得有环」必须先读代码验证**。一个没有用户的机制 + 一条错误的依据，
> 代价是双份的——它违背设计原则（不是 cordis 概念，二期要多一层翻译），
> 而且它的语义陷阱（单元内 inject 不校验）会误导后来的使用者。

alysia 消息处理链的**实际**形状（严格单向）：

```
al:eventbus   →   （无依赖）
al:coalescer  →   al:eventbus     coalescer.ts:185 eventBus.put(merged, {priority:true})
al:pipeline   →   al:coalescer    llm-agent.ts:159/254 ctx.coalescer
```

真出现环时的处置顺序：① 先验证是不是真的环；② 是的话优先把环上模块**合并成一个**；
③ 仍不合适才考虑给宿主加坡处理。**不要预先建机制。**

## 3. 单测要求

用**真实的 alysia 模块形状**做 fixture，不用抽象 `A`/`B`——否则契约正确性无法在 P1 兑现。
（`packages/core/tests/kernel/fixtures.ts`）

> ✅ **2026-10-01 已落实**（change: `add-module-tests`）：
> 内核自身有 32 用例；**13 个业务模块各有单测**（`packages/core/tests/modules/`，28 用例），
> 用 `runModule()` 在隔离宿主里跑真模块、只 stub 它的依赖。
>
> 模块内部日志**必须走 `ctx.logger`**（内核注入）而非模块级 import 的全局 logger——
> 后者绕过宿主，模块在隔离测试里注入的日志器收不到，日志类断言写不出来。

| fixture | 验证什么 |
|---|---|
| `al:db → al:memory` | 基础拓扑 + inject 就绪性 |
| `al:vector`（`critical:false`，apply 抛错） | 降级路径：宿主不中止，依赖方拿到 `undefined` |
| `al:eventbus → al:coalescer → al:pipeline` | 噪声靠真实单向链；每个模块在 apply 内真的拿得到依赖（拿不到会 throw） |
| 分叉依赖（两个消费者共享一个提供者） | 提供者只装一次 |
| dispose 逆序 | 含 async disposer + 抛错 disposer |

## 4. 明确不做

| 不做 | 理由 |
|---|---|
| 配置 schema 校验 | 二期映射 cordis Standard Schema 时补 |
| HMR / 热重载 | dsh 有；alysia 是长驻进程，不需要 |
| 服务发现 / 自动装配 | 宿主只认显式 `use()` |
| `ctx.override` | 等真有需求再加 |
| **双向依赖 / `peer`** | §2.4：依赖图必须是 DAG；曾有 `peer`，依据错误，已删 |
| scope / isolate / realm | dsh 的概念（`docs/dsh-plugin-architecture.md` §2.2）；alysia 单进程单实例，不需要 |

## 5. 对现有代码的约束（P1 的验收基线）

本 change **零侵入现有代码**（无任何 `.ts` 被修改；只有 `HANDOFF.md` / `specs/index.md` /
`alysia-architecture/spec.md` 三个治理文件按 apply 要求更新）。

> ✅ **2026-10-01 已兑现**：P1（change: `modularize-core-assembly`）已把 `AlysiaCore.start()`
> 改成「注册 13 个模块 + 跑 ModuleHost」，下列行为**逐位保留**并经冒烟测试锁定。
> 模块定义在 `packages/core/src/modules/`。详见该 change 的 `tasks.md`。

P1（`modularize-core-assembly`）迁移时必须逐位保留的现存行为：

- LanceDB 失败 → `logger.warn` + `vectorStore = null` → 文本检索兜底（`index.ts:122-124`）
- `loadRolePackages` 失败 → 静默跳过（`index.ts:293`）
- **`bootstrap.ts:246` 覆盖 `index.ts:305` 的 reminder 工具**——这是 `ToolRegistry` Map 同名覆盖
  的隐性行为，迁移时必须保留（或显式记为一次覆写）
- `AlysiaCore` 的公开面**不变**：`memoryManager` / `providerManager` / `toolRegistry` /
  `commandRegistry` / `eventBus` / `scheduler` / `coalescer` / `isGenerating()` /
  `registerPlatform()` / `registerChatTools()` / `registerCodeTools()` / `stop()`
  （server 与 console 依赖它们；console 对 core 是零 import，纯 HTTP）

### 5.1 server 侧的落实（P3，change: `modularize-server-assembly`）

> ✅ **2026-10-01 已兑现**：`packages/server/src/bootstrap.ts` 从 ~330 行总装脚本
> （配置 → core → 三个 IM 适配器 → vision → proactive → life（含 6 段巨型 systemPrompt）
> → reminder → cron → webui → 信号处理）降为「**建宿主 + 注册 10 个模块 + 跑**」。
> 模块在 `packages/server/src/modules/`，全部**逐行搬运**（含条件门 `IS_DESKTOP` / `qqOff` /
> `ownerId` 与日志措辞）。
>
> **验收方式**：真启动服务 + curl 全部端点，**比对响应字节数**——
> 改造前后 `/api/life` 14998 B、`/api/profile` 42752 B、`/api/stats` 1641 B **完全一致**；
> 启动日志逐行相同（仅多一行 server 宿主汇总）。源码改动面 `bootstrap.ts` −317/+66。

server 侧 10 个模块与依赖图（`packages/server/src/modules/index.ts`）：

```
层级0  al:config
层级1  al:logging ←(config)          al:vision ←(config)
层级2  al:core ←(config, logging)
层级3  al:adapters ←(core, config, vision)        ← 提供 al:push
层级4  al:proactive / al:reminder ←(core, config, push)
层级5  al:life ←(core, config, push, proactive)
       al:cron ←(core)
       al:webui ←(core, config)
```

server 侧同样**必须靠断言/注释守住**的隐性行为（破坏了不报错）：

- **`al:reminder` 必须 `inject: ['al:core']`** —— `al:core` 先注册 no-op 版 reminder 工具，
  server 侧之后覆盖成真实持久化版本（`ToolRegistry` 的 Map 同名覆盖）。
  顺序反了会**静默用错版本**。
- **`consoleDist` / `staticDist` 路径解析刻意留在 `bootstrap.ts`** —— `import.meta.url`
  在 dev 是 `src/bootstrap.ts`、prod 是 `dist/bootstrap.js`，上溯两级才到 `packages/`；
  挪进 `src/modules/` 会多一层上溯 → `existsSync` 为 false → **静态路由静默不注册、
  SPA 白屏且无报错**。
- **`PushChannel`**（`packages/server/src/push.ts`，本 change 抽出）—— `life.ts` /
  `proactive.ts` 的 `qqOff` 参数类型从具体适配器收窄为 `PushChannel` 接口
  （两者都**只用** `sendProactive`），使 life/proactive 不再耦合平台适配器。

⚠️ **内核暴露的能力缺口**：`al:core` 需要「启动日志必须落进 `al:logging` 已配置的文件」，
但 `al:logging` 是 `provides: false`，而内核**没有「只排序、不依赖服务」的表达方式**。
当前用**能力令牌**绕过：`al:logging` 提供真值 `al:logDir`（日志目录），`al:core` 注入它
**只为排序**、不使用该值。这类需求 ≥3 处时应给 `Module` 加 `after?: string[]`
（本 change 不做，已登记 `docs/KNOWN-ISSUES.md` KI-10）。
