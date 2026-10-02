# dsh 插件体系原理 + Alysia 模块化拆解设计

> 日期: 2026-10-01
> 状态: 待评审
> 目标读者: 后续接手 alysia 模块化 / dsh 迁移的人
> 上游: `docs/dsh-migration-guide.md`（2026-08-19，迁移参考）、`openspec/specs/dsh-adapter/spec.md`
> 依据版本: dsh-desktop **0.2.0-rc.2**（`E:\dsh`，2026-09-29 构建）；源码树 `deepseek-harness-master` 是 0.1.0-rc.5（8-13，**已落后，仅作结构参考**）

---

## 0. 一句话

**先做 (a)**：在 alysia 内部把 `AlysiaCore.start()` 的总装脚本拆成 cordis 形状的模块宿主；
**再做 (b)**：把模块包装成 dsh 插件。本文件给出 (a) 的设计和 (b) 的对接约束。

---

## 1. 背景：现有集成已失效（2026-10-01 查证）

### 1.1 桌面端打断了两层集成

| 断点 | 证据 |
|---|---|
| desktop profile **不加载** alysia 插件 | `resources/app.asar` → `lib/main.js` 的 `resolveDesktopPaths()` 硬编码 `~/.dsh/profiles/desktop`；该 profile 的 `package.json` 依赖为空、bundles 只有 `dsh-base`+`dsh-web-app`。`@alysia/dsh-console` 挂在 **web** profile |
| `.agent-presets/` 目录**已废弃** | 官方 skill 原文：*"Nothing reads that directory any more."*（`dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`）。整个 app.asar 12967 个文件中该字符串**仅出现在这段迁移说明里** |
| `tapIndex` 在桌面端**不执行** | 桌面端注册自定义协议 `dsh-app://`：index.html 直接从 asar 内 `dsh-web-frontend/dist` 静态送出，只有**非静态**路径才 `forwardWebRequest` 转发给后端。注入走 `collectIndexInjections()` → IPC(`dsh-desktop:boot`) |
| persona section 改名 | `deployment:persona` → **`deployment:persona-prefix`**（order 0），另有 `deployment:persona-suffix`（order 10200）。`dsh-adapter/src/types.ts` 里硬编码的 `PERSONA_SECTION` 已失效 |

### 1.2 仍然有效的部分

- ✅ `ctx.webServer.register({kind:'exact'|'prefix'})` 的路由**可达**（`dsh-app://app/...` 非静态路径会转发；`/plugins/*` 也转发 → 客户端 UI 插件在桌面端可用）
- ✅ `systemPrompt.section/context/variable` 签名未变
- ✅ `ctx.tools.register()` + `output:{schema,render}` 硬约束仍在（`assertSupportedJsonSchema`）
- ✅ `session/event`、`session/disposed` 仍在

---

## 2. dsh 插件体系原理

### 2.1 Cordis 内核

**插件形态**（三种，`export default` 与 `export function apply` **绝不能混用**——Loader 会丢弃函数插件的整个命名空间）：

```js
// 函数插件（推荐）
export const name = 'alysia-memory'
export const inject = ['systemPrompt', 'tools']   // 声明服务依赖；cordis ctx 是 Proxy，未声明即抛
export const Config = Schema.object({ ... })       // Standard Schema，必须同步
export function apply(ctx, config) { ... }
```

**`ctx` 语义**
- `ctx.get(name)` 取服务；`inject` 声明后可直接 `ctx.foo`
- `ctx.effect(() => disposer)` —— **一切注册必须走它**。不走 → 卸载/HMR/agent 销毁时不回收，泄漏 + 重复注册
- `ctx.on(event, handler)` 返回 disposer，随 ctx 卸载自动清理
- disposer **逆序执行**、可 async、单个抛错被 logger 吞掉（别指望抛错能中断其他 disposer）
- **保序 teardown 用 generator effect 按序 `yield`**，并列多个 `ctx.effect()` 是并发兄弟，顺序不保证

### 2.2 scope / isolate / realm（★ 最容易踩）

三层"局部性"概念，**互不相同**：

| 机制 | 作用 | 关键事实 |
|---|---|---|
| **scope** | 控制**贡献可见性**和**事件可见性** | 只有 `scopeOf()` 归档的注册表和 `scopeTarget()` 派发的事件才隔离。**任意 service 仅因"通过 scoped ctx 调用"不会隔离** |
| **isolate** | 控制**服务实例** | `isolate: {x: true}` 的 realm suffix 是 `#<entry.options.id>`；同 label 字符串共享 `@<label>` |
| **realm** | isolate 产生的实例空间 | — |

**★ `isolate` 是 per-ENTRY，不是 per-agent。** 误以为"每个 agent 一份独立 service"→ 实际是"每个 preset 一份"。同 preset 的所有 agent **共享**同一份 isolated service。

**★ preset 内提供任何 service，必须让 provider 和所有 consumer 落在同一个 `group: true` + `isolate` 行的子树内**，否则挂载时直接抛：

```
Error: Preset services require isolate realms: <leaked names>
```

且这条**不只在挂载时检查** —— `internal/service` 上还有运行时复查，异步续段里后注册的服务也会被抓。

**★ `isolate` 必须写在包住 provider+consumers 的 `group: true` 行上**——子 entry 靠 `Object.create(parent[Context.isolate])` 原型链继承；写在子行上则兄弟行解析不到，插件永远 PENDING。

### 2.3 装载链路

```
$DSH_HOME/profiles/<name>/
├── cordis.yml          # 空入口列表 []（树由 patch 组装，别改这个）
├── cordis.patch.yml    # 用户 patch 层（可以改这个）
└── package.json        # dsh.profile.bundles: ["@deepseek-ai/dsh-base", ...]
```

**bundle** = 一个 npm 包，`package.json` 里声明 `dsh.bundle.patch` 指向一个 patch YAML。
**patch 方言**（顶层是 `insert` 列表）：

```yaml
- insert:
    - id: my-row                    # 全局唯一，建议加项目前缀避免和出厂行撞名
      name: '@scope/pkg'            # 或 'cordis:group'（唯一内置名之一）
      config: { ... }
- id: some-shipped-row              # 按 id 覆写（替换整个 config）
  config: { ...重述全部字段... }
- id: another-row
  disabled: !!js process.platform === 'win32'
```

| 语义 | 规则 |
|---|---|
| `config` | **整体替换，绝不深合并**。覆盖任何行必须重述全部想保留的字段 |
| `insert` + `id` 的目标 | **必须是 `group: true` 的行**，否则 warn + skip（静默跳过） |
| 非 insert patch | **必须有非空 `id`**；匹配不到 → warn + skip（不失败） |
| 配合 `id` 的 `name` | 是**断言**，不匹配 → warn + skip；`name` **不会**被写入目标行 |
| `!!js` | 必须是**双叹号**。`config` 内求值 → 该插件自己的 context（**已声明 inject 激活之后**）；`disabled` 内 → Loader context，**每次挂载决策时** |
| `group: true` | **永远启用**；子行 disabled 由父链逐级判定 |
| `isolate` | 值只能是 `true` 或字符串 label（不能数字/对象） |
| `disabled: false` vs `null` | `null` 会**删掉**该键（不是"不覆盖"） |

### 2.4 名字解析

| 形式 | 规则 |
|---|---|
| `cordis:group` / `cordis:include` | 仅有的两个内置名。**preset 里必须用 `cordis:group`**（preset 在工作区外，按名字解析不到包） |
| 相对路径 `./` `../` | 锚定在**patch 文件旁**，仅限 `insert` 行及其嵌套 group 内会被转 file URL |
| **绝对盘符路径** | **必须写在 `insert:` 行里**让 patch loader 转 file URL。直接写 `E:/foo` 会被 `new URL('E:/foo', baseUrl)` 解析成**协议头 `e:`** |
| **TS 源码** | 🔴 **不能直接加载**，必须产出 JS（`type: "module"` + `export function apply`） |
| `cordis:include` | path 扩展名只支持 `.yml` / `.yaml` / `.json` |

### 2.5 agent 与 preset

- preset = `@deepseek-ai/dsh-agent-preset` 的 **declaration**，由 bundle patch 携带：

```yaml
- insert:
    - id: preset-alysia
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: alysia                       # 小写字母/数字/连字符
        name: 昔涟聊天
        description: ...
        order: 10
        plugins:                          # Cordis entry list
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: '...' }
          - id: tool-recall
            name: '@alysia/dsh-tool-recall'
```

- 出厂 preset 只有 4 个：`standard` / `ptc` / `minimal` / `cordis`（在 `dsh-web-app/presets/*.patch.yml`）
- preset revision **eagerly activated once and shared by their selecting Agents**；改 preset 后**已有会话保持它们启动时的 revision**，新行为只在新会话可见
- Loader row id 约定 `preset-<id>`

### 2.6 扩展点清单

| 需求 | API | 备注 |
|---|---|---|
| 人设 | `@deepseek-ai/dsh-persona`（`config.prefix`/`suffix`/`complete`/`includeRuntimeContext`） | **只能在 scoped composition 里挂**，全局挂会与 prompt registry 冲突并 loud fail |
| 提示词段落 | `ctx.systemPrompt.section({name, order, text, complete?})` | 同层重名 / 非有限 order → throw；多于一个生效的 `complete: true` → assembly 失败 |
| 动态上下文 | `ctx.systemPrompt.context({name, order, text})` | 渲染为 user-role runtime snapshot |
| 模板变量 | `ctx.systemPrompt.variable(name, provider)` | 变量名必须匹配 `/^[a-z][a-z0-9_]*$/`；**严格校验**：未知引用 / 值为 `undefined` / 畸形 group 一律 **throw** |
| 工具 | `ctx.tools.register(defineTool({...}))` | 见 §2.7 |
| 会话日志事件 | `ctx.on('session/event', (session, event) => ...)` | `event.type` 是 SessionEventMap 里的类型 |
| 会话结束 | `ctx.on('session/disposed', ...)` | — |
| 会话开始 | `ctx.on('agent/session-start', ...)` | ⚠️ 见 §2.9 待实测 |
| profile 级 HTTP | `ctx.webServer.register({kind:'exact'\|'prefix', path, handler})` | 桌面端可达（转发） |
| index 注入 | `ctx.on('webserver/index-inject', table => table.push(row))` | 行类型 `global\|script\|script-src\|script-preload\|style\|html`。**桌面端唯一有效方式**（`tapIndex` 不执行） |
| UI 插件 | slot 体系 | 桌面端支持（`/plugins/*` 转发） |
| MCP | `dsh-mcp-client` | 一行接外部 server，工具名 `mcp__<server>__<tool>` |

### 2.7 工具契约

```ts
ctx.tools.register(defineTool({
  name: 'recall_memory',
  description: '...',
  parameters: { query: { type: 'string', required: true, description: '...' } },  // ★ spec 形式，不是 raw JSON Schema
  output: {
    schema: { ... },            // 也走 spec → valueSchemaSpecToJsonSchema
    render: (args, value) => [...],
  },
  execute: async (args, exec) => { /* 必须观察 exec.signal */ },
}))
```

`ctx.tools.register()` **也接受手搓 raw 定义**（`output:{schema,render,presentationMeta?}` + raw JSON Schema `parameters`），走 `assertSupportedJsonSchema`。

**坑**：
- `timeoutMs` **只是声明性的，registry 从不强制** —— 要生效得挂 `@deepseek-ai/dsh-tool-call-timeout-policy`
- `isConcurrencySafe` **只有精确 `true` 才算并行**，未声明/抛异常一律独占（fail-closed）
- execute **必须协作 `exec.signal`**，取消是协作式的
- 工具必须**只返回声明的 canonical JSON 值**，不要返回 content block、不要让调用方解析散文
- 注册**借用**你的 readonly definition —— 注册后**不要 mutate** schema 或替换回调
- 保留工具名：`run_code`（注册直接失败）

### 2.8 定时任务（★ 对 LifeService/ProactiveService 直接相关）

`dsh-schedule` **不能单独挂载**，delivery 需要 **Host Web Session controller** + **Session persistence backend**。
→ **schedule 必须是 Host 行（profile patch / bundle），不能放进 preset。**

若 LifeService/ProactiveService 需要放进 preset，则必须：
- 自建 timer + `agent.followup()`（**唤醒** agent；`agent.inject()` 不唤醒）
- 自己解决「idle 判定」（用 `turn/end` / `assistant/message` 等持久事件，**不要轮询 `agent/status`**）
- 自己解决「跨重启」（状态放 `ctx.storageDomain` 或 `$DSH_HOME` 下的文件）
- **timer 必须清在 owning effect 里**

### 2.9 硬约束速查（会导致挂载失败 / 静默失效）

仅列对 alysia 直接相关的。完整 72 条见调研报告。

| # | 约束 | 后果 |
|---|---|---|
| 1 | `export default`(class) 与 `export function apply` **不能混用** | 🔴 Loader 丢弃整个命名空间 |
| 2 | `Config` 必须 Standard Schema 且**同步** | 🔴 异步校验抛 `TypeError` |
| 3 | **一切注册走 `ctx.effect()` / `ctx.on()`** | 🟠 卸载不回收 → 泄漏 |
| 4 | 在 `agent.ctx` 上注册有**两个 owner**，必须同时把 disposer 按 agent 键存进插件自己的 effect | 🟠 只卸载插件不 dispose agent 层 |
| 5 | preset 内提供 service 必须 `group:true` + `isolate` | 🔴 `mountPreset` 直接抛 |
| 6 | `isolate` 是 per-ENTRY 不是 per-agent | 🟠 以为每 agent 一份 |
| 7 | `config` **整体替换，绝不深合并** | 🟠 静默丢配置 |
| 8 | **TS 源码不能直接加载**，必须产出 JS | 🔴 |
| 9 | 绝对盘符路径必须写在 `insert:` 行里 | 🔴 否则被解析成协议 `e:` |
| 10 | **绝不能 append 新 `type` 的 session 事件** | 🔴 **会话直接损坏**（`Session.append()` 无法设 `ignorable`） |
| 11 | `{{变量}}` 严格校验，未知引用**直接 throw** | 🔴 assembly 失败 → 请求发不出 |
| 12 | 不要手写 profile 的 `package.json`/`cordis.patch.yml`，不要在 `$DSH_HOME` 下建包，不要在 profile 目录跑 pnpm | 🟠 与 `install_bundle` 冲突 |
| 13 | 安装 bundle 走 `plugin_manager` `action: install_bundle` + 绝对包目录 | — |
| 14 | 替换已安装的包**需要重启进程**；新装 bundle 可以走 HMR | 🟠 |
| 15 | bundle 的 `peerDependencies` 不匹配 → **整个 bundle 被静默跳过**（进 `skippedBundles`，不报错） | 🟠 |

### 2.10 待实测确认

| # | 问题 | 影响 |
|---|---|---|
| 1 | **`agent/session-start` 在 0.2.0-rc.2 是否存在** —— api-catalog 的 `EVENT_API` 里没有，但源码 `runtime-types.ts:217` 声明了 | 「会话开始注入记忆」的天然位置。备选：`agent/created` + `session/created` |
| 2 | `dsh-schedule` 在桌面端（`dsh-app://` 而非 `dsh web`）的 Host 依赖是否齐备 | 决定 LifeService 走 Host 还是自建 timer |
| 3 | `EVENT_API`(85 条 cordis 事件) vs `SessionEventMap`(15+ 条持久化日志事件) 是**两个层次** | 设计时别混淆 |
| 4 | 在 preset 插件里 `ctx.on('agent/status', ...)` 能否收到事件（要不要用 `agent.ctx`） | 事件订阅的正确姿势 |
| 5 | `followup()` 在 agent 已 running 时是排队还是 steer | 主动消息的时序 |
| 6 | `--patch` 层 vs home 层的精确优先级（三处文档措辞不一致） | patch 调试 |

---

## 3. Alysia 现状：主 agent 构造解剖

### 3.1 两个装配点

| 位置 | 步骤 |
|---|---|
| `packages/core/src/index.ts:101-262`（`AlysiaCore.start()`） | 13 步：DB → LanceDB → embedService → llmService → MemoryManager → seed → roles → ProviderManager → ToolRegistry → CommandRegistry → Coalescer → Pipeline(7 stages) → EventBus |
| `packages/server/src/bootstrap.ts:28-322`（`main()`） | 6 步：配置 → AlysiaCore → IM 适配器 → ProactiveService → LifeService → 提醒 → cron → WebUI |

**`AlysiaCore.start()` 不是容器，是总装脚本**——15 个步骤硬编码在一个方法里，**零插件注册机制**。

### 3.2 已有的扩展点（拆解的有利条件）

| 抽象 | 文件 | 形态 |
|---|---|---|
| `ToolRegistry.register` | `core/src/tools/registry.ts:48` | `Map<name, ToolDefinition>`，**同名覆盖** |
| `ProviderManager.registerProvider` | `core/src/provider/manager.ts:9` | `Map<id, OpenAIProvider>` |
| `CommandRegistry.register` | `core/src/commands/registry.ts` | — |
| `PipelineScheduler.addStage` | `core/src/pipeline/scheduler.ts:22` | 数组 push（**仅追加**） |
| `EventBus.registerScheduler` | `core/src/eventbus/EventBus.ts:19` | `Map<umo, PipelineScheduler>` |
| `IVectorStore` / `IEmbedService` / `ILLMService` | `core/src/memory/interfaces/` | 三个现成接口 seam |

### 3.3 耦合面（拆解风险的上界）

- `packages/server` 对 core 只碰 **6 个公开属性**：`memoryManager` / `providerManager` / `toolRegistry` / `commandRegistry` / `eventBus` / `scheduler` + `isGenerating()` + `registerPlatform()`
- `packages/console` 对 core 调用面为**零**（纯 HTTP 消费 `lib/api/client.ts`）
- → **只要 `AlysiaCore` 的公开面 100% 不变，server 和 console 零改动**

### 3.4 天然的双向耦合 / 陷阱

- **Coalescer 的方向性**：Coalescer 把合并事件 `eventBus.put(mergedEvent, {priority:true})` 重入管线，
  且依赖 `PipelineScheduler` 的 async-generator「不 yield 即短路」语义（`coalescer.ts:5` 注释自陈）
  → Coalescer 必须与 PipelineScheduler 一起设计。
  ⚠️ 早期版本这里写成「Coalescer ↔ EventBus 双向依赖，不能拆开」——**那是错的**，
  `EventBus.ts` 全文不引用 Coalescer（见 `drop-kernel-peer`）。依赖是**单向**的：
  `al:eventbus → al:coalescer → al:pipeline`
- **System prompt 有两个组装点**：`PromptAssembler`（只产出"记忆块"）+ `LLMAgentStage:83-155`（11 个 section：人设/世界观/生活衔接/意图协议/表情包协议）→ **只搬前者会丢东西**
- **`MemoryManager` 的内联 `llmService`**（`index.ts:157-177`）绕开 ProviderManager 直连 fetch，**无超时、无 fallback、无 signal**
- **`TOKEN_STATS_FILE = './data/token_stats.json'`**（`MemoryManager.ts:58`）——相对 cwd 的硬编码路径
- **`bootstrap.ts` 里 6 段巨型 systemPrompt**（`generateEvent` 那段 2000+ 字）——提示词资产混在装配代码里

### 3.5 测试基线（实测，2026-10-01）

| 包 | 结果 |
|---|---|
| `packages/core` | **523 passed**（54 files） |
| `packages/server` | **192 passed**（11 files） |
| 合计 | **715** ✅ |

跑之前须把 PATH 里的 node 换成 `E:\nodejs24\node`（v24.19.0），否则 better-sqlite3 ABI 不匹配。

---

## 4. 拆解设计

### 4.1 模块契约（cordis 形状）

核心决策：**内部模块契约直接做成 cordis 形状**，二期包装成 dsh 插件时只写一层薄适配。

```ts
// packages/core/src/kernel/types.ts
export interface Module<S = unknown> {
  /** 模块名 = 服务名，全局唯一，建议前缀 al: 避免和 dsh 出厂行撞名 */
  name: string
  /** 依赖的服务名；宿主按拓扑排序 install */
  inject?: string[]
  /** 配置 schema（一期可省，二期映射到 cordis 的 Standard Schema） */
  Config?: unknown
  /** 安装。ctx 是模块作用域的上下文 */
  apply(ctx: ModuleContext, config?: S): void | Promise<void>
}

export interface ModuleContext {
  /** 取服务 */
  get<T = unknown>(name: string): T | undefined
  /** 注册服务（同名冲突 → throw，不静默覆盖） */
  provide<T>(name: string, value: T): void
  /** 注册清理器。返回的 disposer 会被宿主收集，逆序执行 */
  effect(setup: () => (() => void | Promise<void>) | void, label?: string): void
  /** 事件（内部事件总线） */
  on(event: string, handler: (...args: any[]) => void): () => void
  emit(event: string, ...args: any[]): void
  logger: Logger
  /** 模块自身的配置 */
  config: S
}
```

**宿主** `ModuleHost`：
- 按 `inject` 拓扑排序，循环依赖 → throw
- install 顺序执行，**dispose 逆序执行**
- 失败策略：模块可声明 `critical`（DB / memory）或 `optional`（vector，失败降级并记日志）
- 服务注册走 `provide`，同名冲突 throw（区别于现有 `ToolRegistry` 的静默覆盖）

**与 cordis 的对应关系**（二期适配的依据）：

| 本项目 | cordis |
|---|---|
| `Module.apply(ctx, config)` | `export function apply(ctx, config)` |
| `Module.name` | `export const name` |
| `Module.inject` | `export const inject` |
| `Module.Config` | `export const Config` |
| `ctx.get/provide` | `ctx.foo` / `ctx.set` |
| `ctx.effect` | `ctx.effect`（语义相同） |
| `ctx.on/emit` | `ctx.on` / `ctx.emit` |

### 4.2 模块清单与依赖图

**基础资源层**

| 模块 | 来源 | 依赖 | 失败策略 |
|---|---|---|---|
| `al:db` | `index.ts:103-106` | — | critical |
| `al:vector` | `index.ts:110-124` | — | **optional（可失败降级到文本检索）** |
| `al:embed` | `index.ts:127-152` | — | critical |
| `al:memory-llm` | `index.ts:157-177` | — | critical |

**能力层**

| 模块 | 来源 | 依赖 |
|---|---|---|
| `al:provider` | `index.ts:190-197` | — |
| `al:memory` | `index.ts:179` | db, vector, embed, memory-llm |
| `al:persona-seed` | `index.ts:182-187` | memory |
| `al:tools` | `index.ts:200-204` | memory, db, provider |
| `al:commands` | `index.ts:207-227` | memory |
| `al:pipeline` | `index.ts:236-253` | memory, provider, tools, commands, coalescer |
| `al:coalescer` | `index.ts:232-233` | — |
| `al:eventbus` | `index.ts:256-261` | **无**（`EventBus` 不引用 Coalescer，见 §3.4 更正） |

**服务层（server 包）**

| 模块 | 来源 | 依赖 |
|---|---|---|
| `al:vision` | `bootstrap.ts:83-91` | — |
| `al:life` | `bootstrap.ts:121-210` | memory, provider, adapters, proactive |
| `al:proactive` | `bootstrap.ts:96-118` | memory, provider, adapters |
| `al:reminder` | `bootstrap.ts:216-251` | memory, adapters, tools |
| `al:cron` | `bootstrap.ts:254-267` | memory |
| `al:adapters` | `bootstrap.ts:55-93` | eventbus |
| `al:webui` | `bootstrap.ts:282-319` | memory, **所有只读能力** |

**副产品：提示词资产外置。** `bootstrap.ts` 里 6 段巨型 systemPrompt（`generateEvent`/`generateSummary`/`generateIntentMessage`/`generateMoodNote`/`generateReflection` + reminder 文案）抽成模块的 `prompts/` 资源文件（参照现有 `persona/*.md` 的 loader 模式）。这是拆解最值钱的产出——现在这些提示词和接线代码搅在一起，改一句话要读 330 行。

### 4.3 分期路线（增量，每步测试全绿）

**前置**：打 tag `pre-modularize`（项目现有惯例：`ui-v1-purple` → `ui-v4-cyrene`）

| 期 | 内容 | 验收 |
|---|---|---|
| **P0** | 新建 `core/src/kernel/`（`Module` + `ModuleContext` + `ModuleHost`），**零侵入**，不动任何现有代码 | 新增单测：拓扑排序 / 循环依赖检测 / dispose 逆序 / effect 清理 |
| **P1** | `AlysiaCore.start()` 改写为「注册 13 个内置模块 + 跑 host」，模块实现**先全部内联在 `core/src/modules/`**，对外 API 100% 不变 | 715 测试全绿 + `AlysiaCore` 公开面 diff 为空 |
| **P2** | 把模块**逐个**挪到 `packages/core/src/modules/<name>/`，每挪一个跑一次测试 | 每步 715 绿 |
| **P3** | server 侧：`bootstrap.ts` 拆成 `server/src/modules/`（adapters / life / proactive / reminder / cron / webui / vision） | 每步 715 绿 |
| **P4** | 提示词资产外置（§4.2 副产品） | 提示词逐字 diff 为空（**不许改一个字**） |
| **P5** | `AlysiaCore` 退化为薄门面（facade），承载量降到最低 | 715 绿 |

**P1 是风险点**：改 `start()` 时行为必须逐位一致。建议先把 `start()` 的现有行为写成「模块清单」的注释对照表，再动手。

### 4.4 风险与回滚

| 风险 | 缓解 |
|---|---|
| `start()` 语义漂移（异步顺序、失败降级） | P1 前后各跑一次 715；`al:vector` 的失败降级单独写测试 |
| Coalescer 与 PipelineScheduler 的短路语义拆错 | 两者一起设计（Coalescer 已在 pipeline 内，边界天然） |
| `TOKEN_STATS_FILE` 相对 cwd | 拆 `al:memory` 时显式改为配置项，**不改默认值**（保持 `./data/token_stats.json`） |
| server 侧 `IS_DESKTOP` 分支 | 保留原语义，P3 只挪位置不动逻辑 |
| 回滚 | tag `pre-modularize` + 每期一个 commit |

---

## 5. 二期：映射到 dsh（供 P0/P1 边界设计参考）

**切割边界第一原则**：先问「这个能力是 profile 全局还是 per-agent/per-preset」

| alysia 模块 | dsh 落点 | 理由 |
|---|---|---|
| `al:db` / `al:vector` | **不进 dsh**，留 alysia server | 原生模块 + 磁盘目录；dsh 进程内跑不了（且桌面端在 asar 里） |
| `al:memory` | **不进 dsh**，alysia server 保留权威 | 8 store 全吃 better-sqlite3。dsh 侧通过 HTTP 只读消费 |
| `al:memory-llm` | 收编进 `al:provider` | 现在是内联 fetch 绕开 ProviderManager，是历史遗留 |
| `al:provider` | **Host 插件** 或直接用 dsh 的 LlmAdapter | dsh 已有 LlmAdapter（DeepSeek + SSE + retry）；sampling 槽位映射到 dsh 配置 |
| `al:persona-seed` | **preset 插件**（`@deepseek-ai/dsh-persona`） | 人设文本 → `config.prefix`。不用自己抢 section |
| `al:tools` | **preset 插件**（`ctx.tools.register`） | 工具是 per-preset 的。⚠️ 吃 db/MemoryManager 的那 6 个要走 HTTP |
| `al:commands` | **preset 插件** 或 dsh slash command | — |
| `al:pipeline` / `al:coalescer` | **不搬代码，保语义** | dsh 有自己的 turn/step/tool-call 循环。只保留「私聊并发/群聊串行」「合并只并请求不并结果」「打断结果永不发送」，用 `coalescer.test.ts` 的 9 个场景做验收基线 |
| `al:eventbus` | dsh session 事件 | dsh 无 IM 适配器 → QQ 适配器是**全新插件** |
| `al:life` / `al:proactive` | **Host 插件**（`dsh-schedule`）或 preset 内自建 timer | `dsh-schedule` 不能单独挂载，必须是 Host 行。若要进 preset 则自建 timer + `agent.followup()` |
| `al:adapters` | **全新插件** | dsh 无 IM 适配器 |
| `al:webui` | dsh 客户端 UI 插件 + `webserver/index-inject` | ⚠️ 桌面端 `tapIndex` **不执行**，必须用结构化注入行 |

**打包形态**：一个 bundle 一条 `insert` 列表，行 id 加 `alysia-` 前缀（patch 的 id 索引是**全树扁平**的，通用名会和出厂行撞）。

**必须遵守**：
- 产出 **JS**（不能是 TS 源码）
- 绝对路径必须写在 `insert:` 行里
- 走 `plugin_manager` `install_bundle`，**不手写 profile 文件**
- preset 内提供 service → `group: true` + `isolate`

---

## 6. 参考

- `docs/dsh-migration-guide.md` — 2026-08-19 迁移参考（架构/坑位清单）
- `openspec/specs/dsh-adapter/spec.md` — dsh 插件适配层 spec（双进程模型已定）
- `openspec/specs/alysia-architecture/spec.md` — 总体架构
- alysia 装配点：`packages/core/src/index.ts`、`packages/server/src/bootstrap.ts`
