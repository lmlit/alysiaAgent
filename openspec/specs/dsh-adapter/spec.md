# dsh-adapter — DSH 插件适配层

> 把 Alysia 昔涟人格/记忆系统接入 DeepSeek Harness(dsh)。dsh 提供聊天/编程 UI、agent 循环、LLM 适配、工具管线;本层把 alysia 的核心资产(人格、记忆、世界书、生活事件)以 cordis 插件形态注入。
> 背景:`docs/dsh-migration-guide.md` §5(迁移对接建议)。

## 1. 概述

- **形态**:cordis 插件(`name` + `Config` schemastery schema + `apply(ctx, config)`),打包为 `packages/dsh-adapter`,通过 agent-preset composition 绝对路径加载,不侵入 dsh 源码树
- **职责边界**:dsh 负责 UI/agent 循环/LLM/工具执行;插件负责「昔涟人格 section + 记忆 context + 生活事件 variable + alysia 工具 + 消息 ingest hook」
- **进程模型**:双进程。server 进程(QQ 适配器/LifeService/Fastify)为记忆权威写入者;dsh 进程内插件为只读消费者,所有写操作经 server Fastify API 代写(**2026-10-01 起已落地**,见 §2.5)

## 2. 关键机制

### 2.1 Persona 注入(替代 PromptAssembler 的 chat 模式)

- 注册 `systemPrompt.section({name: PERSONA_SECTION, order: PERSONA_ORDER, ...})` 影子覆盖部署 persona(`@deepseek-ai/dsh-system-prompt` 导出常量,不硬编码)
- ✅ **2026-10-01/10-02 已落地**:人设文本**不写死在 preset 里**——preset 的 persona 行写 `prefix: '{{alysia_persona}}'`,
  由 `packages/dsh-adapter/src/persona-variable.ts`（**host 插件**，profile 级）注册该变量,
  取值走 `GET /api/persona/prompt`（`alysia-client.getPersonaPrompt()`）。
  好处:换人设**不用改 preset**（预设 id 是持久化契约,改名会打断已有会话——见 §5）
- `complete: true` 可完全接管 sections(不影响 contexts/tools/variables 组装),后续按需启用

> ⚠️ **2026-10-01 修复**:此前 `system_prompt` **从未进入 system prompt**——
> 数据侧被 `importRole` 整行 UPDATE 冲成 `''`,直到 `fix-role-import-wipes-persona` 才修好。
> 修后 `GET /api/persona/prompt` 从 0 字 → **6375 字**（人设核心紧凑形式）。
> 代价:每轮多 ~6.4KB context。

### 2.2 记忆 context(替代 MemoryRetrievalStage)

- `systemPrompt.context({name: 'alysia:memory', text: provider})` 注入检索结果快照
- **AssembleContext 不含用户消息**(只有 `{scope?, signal?}`)——插件缓存最近一次 `session/event` 的 `user/message` 文本,作为检索 query
- ✅ **2026-10-02 已落地**（change: `bridge-memory-read`）:provider 内调 server API
  **`POST /api/memory/read`**（`{query, mode?, limit?, sessionId?}` → `{context, retrieved}`）,
  `context` 由 server 侧 `read()` + `assembleWithWorldbook()` 组装,**与聊天管线同一套**。
  - **空 query 也照常返回**（`[关于你]` 等块不依赖 query）——这是**预热**的前提
  - **缓存 + 后台刷新**：挂载时预热一次（空 query）→ 第一轮就有画像;
    `session/event` 的 `user/message` 到达后用**原话**刷新（话题相关）;
    失败**保留旧值**（provider 同步返回,宁可旧不可空/抛）
  - ⚠️ **dsh 的 prompt provider 是同步的**（`assemble()` 虽 async,但 provider 调用点无 await）,
    所以记忆只能给缓存 → 查询相关的 `[相关记忆]` **慢一拍**（用上一句的检索结果）。
    要即时的让她调 `recall_memory`（异步、带 query、准确）。
  - ⚠️ **预热要去重**:桌面端启动恢复多个会话 → 每会话挂一个插件实例 → 实测一次启动打 **9 次**
    `/api/memory/read`。已提到**模块级共享** + `prewarmReuseMs` 旋钮（默认 30s,`0`=每次重拉）;
    只去重预热,带 query 的刷新**逐会话不去重**。
  - ⚠️ **乱序：预热不得覆盖更新的刷新**（2026-10-16，change: `fix-memory-context-ordering`）。
    两条链（挂载预热 / 用户消息刷新）都会 `.then(setMemoryContext)`，
    而预热**更早发起、可能更晚返回** ⇒ 它落地时会把话题刷新的结果**盖掉**，
    那一轮她看到的记忆比上一轮**还旧**（且两处都成功，日志看不出问题）。
    **契约**：每次**发起**检索时领一个**单调递增序号**（序号必须在 `await` **之前**领，
    不能在 `.then()` 里领），结果落地时**不比已应用的更旧才允许写入**（`seq < appliedSeq` 丢弃）。
    空结果**不推进**已应用序号（保持「失败保留旧值」）。
    正常顺序（预热先回、刷新后回）行为不变。

### 2.3 生活事件 variable

- `systemPrompt.variable('alysia_life', provider)` 注册 `{{alysia_life}}`
- **严格校验**:模板引用未注册/未提供值的变量 → assembly 直接 throw;不引用即安全。
- ⚠️ **`alysia_life` 至今仍是骨架**（生活事件注入未做）。要做的话走 §2.2 那套
  「缓存 + 预热」模式（同 reason:provider 同步）,或调 `memory.getLifeEventInjection()`。

### 2.4 工具注册(替代 ToolRegistry)

- `ctx.tools.register(ToolDefinition)` —— **硬约束**:必须带 `output {schema, render, presentationMeta?}`,参数/返回值 lossless JSON,execute 协作 `exec.signal`
- ✅ **2026-10-02 已落地**:`recall_memory` 是**真工具**——工厂 `createRecallMemoryTool(client)`
  （`packages/dsh-adapter/src/recall-memory.ts`）,`execute` 打 `POST /api/memory/read`。
  - **服务不可达 → 返回 note 而不是抛**（她只是想回忆点事,不该让整轮工具调用失败）
  - 协作 `exec.signal`（已取消则不发请求）
- 仍待做（**不是**「二期」,是「尚未接」）:其余工具走 server API 代写 ——
  `adjust_persona`/`switch_role`/`import_knowledge`/`list_life_events`/`set_reminder`

### 2.5 消息 ingest hook(替代 MemoryIngestStage / SessionEndProcessor)

| dsh 事件 | 用途 |
|---|---|
| `session/event`(type=`user/message`) | 用户消息 → `memory.ingest()`（**经 `POST /api/ingest` 代写**） |
| `session/event`(type=`assistant/message`) | AI 回复回写 |
| `session/disposed` | 会话结束 → **等全部已排队/在途消息确认落库后** → `memory.onSessionEnd()`（复用 `POST /api/sessions/:id/extract`）；回传失败则**挂起结算**（见 §2.5.1 契约 5/6） |

- **★ 子 agent 会话必须显式过滤**（2026-10-02，change: `exclude-subagent-sessions-from-bridge`）：
  preset 是**一个 standing mount 被所有 agent 共享**——父 agent 与子 agent 的 scope key
  都直接绑到同一个 standing key（dsh `packages/preset/agent-presets/src/index.ts:275-288`、`:316-325`），
  而 scope 事件**向上冒泡**：注册在祖先 scope 的监听器**会收到所有后代 scope 的事件**
  （`packages/core/scope/src/index.ts:170-185`）。
  ⚠️ 本节原句「插件在 preset 内挂载 → scoped 监听天然只收本 agent 事件」**已被实证推翻**
  （2026-10-02：11 个子 agent 会话、127 条事件进了库，污染了人格摘要/adaptation_hints/user facts）。
  **契约**：`session.header.origin === 'subagent'` 的会话**一律不回传、不结算**——
  子 agent 是主 agent 派出的执行单元，其内容（任务书 / 工具过程 / 审计报告）不是「她与用户的对话」；
  产出由**主会话摘要**覆盖（主会话摘要本就写着「派了 N 路 subagent」）。
  跳过**必须可观测**（每个子会话首次出现打一行 `info`），不许静默丢弃。
- ✅ **2026-10-01 通道已落地**（change: `connect-dsh-alysia-bridge`）——
  `POST /api/ingest`（**只接受 `dsh:` 前缀的会话**，前缀同时是来源标记）、
  读通道 `GET /api/persona/prompt`；会话结算复用现成的
  `POST /api/sessions/:id/extract`（= `sessionEndProcessor.process()`，**不需要新建**）。
- ✅ **2026-10-01 插件侧也已接入**（同一 change 的下二段）:人格缓存刷新 + 对话回传 +
  会话结束触发结算。此前那句「只有通道、没有回传方」的记录**已过时**。
- **来源标记用 session 前缀**（`dsh:…`），**不给 `EventSource` 加枚举值**——
  加了会让所有 switch 它的下游出现未覆盖分支。
- ⚠️ **回传的 `source` 必须是 `'code'`**（2026-10-02，change: `record-dsh-as-coding-mode`）:
  `RealtimeProcessor` 按 `source === 'code'` 分流世界书 scope。标成 `'chat'` 会让
  在 dsh 里干活的对话**按闲聊的 scope 匹配世界书**（`chat` 条目误触发、`code` 条目匹配不到）。
  语义上 `'code'` 指**来源环境**（dsh 是编程环境），不是话题分类。
- **写接口不该能往 QQ/WebUI 会话注入消息**——`/api/ingest` 只收 `dsh:` 前缀就是这条约束。
- ⚠️ **回传必须分片且串行**（2026-10-16，change: `fix-dsh-ingest-and-settlement`）——
  队列上限（500）**大于**服务端单批上限（200），整批直发必然 413；
  且 4xx 曾被当作可重试故障放回队列，**同样的输入永远重复同一个 413** ⇒ 队列永久卡死。
  契约见 §2.5.1。
- ★ **合成注入不算用户发言**（2026-10-16，change: `filter-synthetic-context-inflow`，KI-20）：

  dsh 每一步之前会把「动态运行时上下文」投影成**一条 `user/message` 事件**塞进会话
  （`RuntimeContextProjection.project()`；文本形如
  `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.…`）。
  它和真实用户发言**同型**，所以 adapter 的「用户消息」监听器会照单全收 ⇒
  这段文本以 `role:'user'` 入库 ⇒ **画像回吸 / 记忆触发记忆**两条自指回路。

  **判据必须用结构化来源，不许用文本前缀**：

  | 判据 | 可用性 |
  |---|---|
  | `data.message.source.kind === 'runtime-context'` | ✅ **主判据** |
  | 文本以那句 runtime-context 抬头开头 | ❌ **不作判据** |

  为什么结构化判据可靠：dsh **自己**就是靠 `message.source.kind` 从**已提交事件**
  （`session.snapshotEvents()` + `isOwned()`）里回溯该快照的 ⇒ 该字段**能挺过序列化**。
  为什么前缀不能作判据：它与「**用户自己粘贴了类似文本**」直接冲突 ——
  真用户消息带的是别的 `source.kind`，结构化判据按定义不会误伤，前缀会。

  **职责分工**（两侧都要有，但只在一处判）：
  - **adapter 只上报事实**：把 dsh 的 `source.kind` 透传进 `payload.dsh_source`；
    且合成注入**不触发话题刷新**（`onUserMessage` 是为「用户刚说了什么」准备的）
    —— 但它**仍然回传入库**（事件日志不可变，且复盘要靠它）。
  - **服务端只做判定**：`dsh_source === 'runtime-context'` ⇒ 打
    `payload.skip_profile = true` + `payload.synthetic = 'runtime-context'`（跳过原因）。
    ⇒ 拦的是「**它进学习管道**」，不是「它入库」。
  - 跳过**必须留痕**（限频，键按事件类型而**不是按 `seq`** —— 键里带 `seq` 等于没限频）。

#### 2.5.1 回传投递与结算契约

> ★ 2026-10-16（change: `fix-dsh-ingest-and-settlement`）。修 `docs/KNOWN-ISSUES.md`
> **KI-23 / KI-24** 与投递可靠性三缺陷；证据（文件:行号）见该 change 的 proposal。

**契约 1 — 分批**：单次 `/api/ingest` 请求携带的事件数**不得超过服务端上限**
（`packages/server/src/ingest.ts` 的 `MAX_INGEST_BATCH`，当前 200）。
适配器队列上限（`index.ts` 的 `MAX_PENDING`，当前 500）**大于**服务端上限，
因此积压必须**分片**发送，不许整批直发——否则「队列上限大于单批上限」这一条本身就保证会长期卡死。

**契约 2 — 串行化**：同一队列**同一时刻只允许一个发送流程在途**；
后续触发（`turn/end` / `session/disposed`）**复用**在途流程，不另起一条。
`flush()` 的语义从「把当时手里的发出去」改为「**返回一条覆盖在途批次的排空链**」。
理由：原实现在 `flush()` 开头即 `const batch = pending; pending = []`，
在途批次对后来的调用方**不可见**——这是契约 5 那个抢跑缺陷的根。

**契约 3 — 故障分类**：回传失败必须区分三类，**不得压成一个 `null`**：

| 类别 | 判据 | 处理 |
|---|---|---|
| **可重试** | 连接失败 / 超时 / 5xx | 批次放回队列，等下次触发 |
| **永久拒收** | 4xx（含 **413**） | **不进重试队列**；计入计数并**响亮上报** |
| **部分成功** | HTTP 2xx 但 `rejected[]` 非空 | 已受理的不再重发；`rejected[]` 如实上报 |

**413 是契约漂移信号**（服务端上限被下调 / 适配器版本旧），**不许**降级处理。

**契约 4 — 不静默丢弃**：队列上限与丢弃规则（超限丢**最旧**）必须**可观测**；
卡死/丢弃诊断**不受失败降噪影响**——`AlysiaClient` 的「连续失败 3 次后静默」
只适用于**逐次请求**告警，不适用于「队列已卡死」这类**状态**告警。
丢弃计数只在进入丢弃状态时逐条打会刷屏，故改为「进入时报一次 + 每 50 条补报 +
**下次成功排空时汇报真实总数**」——最后一条日志**不许少报**。

**契约 5 — 结算等待入库（KI-24）**：`session/disposed` 触发的结算
**必须等待该会话已排队与在途的消息确认落库**（await 整条排空链）之后才发起。
回传失败时**不得**宣布结算完成，也**不得**无条件继续提取。

> 理由（这部分是**缺陷后果**，不是风格偏好）：服务端结算窗口的锚点是
> 「该会话最新摘要的 `ended_at`」（`MemoryManager.summaryAnchor()`）。
> 迟到事件的 `created_at` 取自 **dsh 的事件时间**（`index.ts` 的 `new Date(event.time || Date.now())`）。
> ⇒ 提前结算会写出一条**不完整**的摘要，而它随即成为下一窗口的锚点。
> 事件本身仍在事件表里，所以 `read()` / 向量召回仍能捞到——丢的是**摘要与画像这一层**，
> 更难察觉。
>
> ★ **2026-10-16 更新（change: `fix-summary-window-late-events`）**：
> 上面这段原先还写着「新落库摘要行的 `ended_at` = **服务端当时时间** ⇒
> 迟到事件**永久**落在窗口之外」。**那个前提已被修掉**——
> `memory-system` §5.4.1 **契约 4** 现在要求 `ended_at` 取
> **窗口内最新事件的 `created_at`**（数据边界），于是迟到事件必然落回下一窗口。
> 两条防线是**互补**的，都要留：
> - **契约 5（本条，适配器侧）**：结算必须等数据确认落库 —— 否则写出的是**残缺摘要**
> - **§5.4.1 契约 4（服务端侧）**：窗口右边界取数据边界 —— 否则**同进程的 cron**
>   （不经过适配器，管不到）会越过尚未入库的数据，造成**永久丢失**

**契约 6 — 失败的再次结算入口**：因回传失败而未能结算的会话
**必须被记住，并在下一次成功排空后自动重试**，**不依赖**「下一次刚好有消息」。
尝试次数设上限，耗尽后打一条**明确失败**日志（含会话 id 与原因）——「没结算」必须可见。
同一会话的挂起结算**去重**（否则会造出 KI-19 的新实例：同一会话被重复摘要）。

> ⚠️ **已知边界**：若插件实例在排空成功前就被卸载，这条重试链随之消失。
> 此时只保证「**不结算 + 响亮失败**」（不写一个假的完成态），不保证补上。

**契约 7 — 身份缺失时 fail closed（KI-23）**：取不到会话 id 时
`sessionIdOf()` 返回 **`null`**（**不再**返回字面量 `'unknown'`）；
调用方**不回传、不结算**，并输出**限频**诊断（每类事件首次一行 `warn`，其后静默计数）。

- **禁止**临时生成随机 id 掩盖上游契约问题。
- **不得**阻断 dsh 自身的聊天与工作（通道失败 ≠ dsh 不可用，见契约 8）。
- 服务端 `/api/ingest` **同步拒收**字面量 `dsh:unknown`（第二道闸；
  `'unknown'` 永远不是真实 dsh 会话 id）。两道闸分工：适配器**不产生**，服务端**不接受**。
- 此纪律与本节「子 agent 会话一律跳过」的 **fail-closed** 一致——
  修 KI-23 前，子 agent 是 fail closed 而身份缺失是 **fail open**，二者不一致正是缺陷所在。

**契约 8 — 永不抛出**：以上所有分支都不许破坏 dsh 侧通道的**根本不变量**——
alysia 未启动是常态，通道失败**绝不能**让 dsh 会话不可用。
（同 `alysia-client.ts` 文件头：「一切调用都是 best-effort」。）

**契约 9 — 事件重复投递**：同一事件 id **同内容**重复投递 ⇒ **幂等空转**
（不重置 `archived` / `processed` / `importance` / `created_at`）；
同一事件 id **不同内容** ⇒ **不覆盖**（Event Log 按 CLAUDE.md 定义为**不可变**），
并**响亮报告冲突**（含 id 与会话），不许静默覆盖。
核心侧实现属 **KI-12**，在既有 change `fix-store-write-trace` 内完成；
本节只钉住**口径**，避免 dsh 侧与核心侧对「重复投递」的理解分叉。

### 2.6 Agent preset(聊天/编程双模式)

- ✅ **已落地**（2026-10-01 bundle 化）:preset **派生自出厂 `standard`**（**保住工具集**——
  这也是编程模式能成立的前提）,人设走 `{{alysia_persona}}` 变量可切换。
  显示名 `昔涟 · 标准`,id `alysia-standard`,Loader 行 `preset-alysia-standard`。
  **命名约定**：`preset-alysia-<模式>` / `alysia-<模式>` / `昔涟 · <模式>`
  （用户拍板方案 a：与出厂模式并存,为后续「昔涟 · PTC」「昔涟 · Cordis」留位）。
- ⚠️ **preset id 是持久化契约**:它写进会话 header（`agentPreset`）与会话日志的
  `agent-preset/selected` 事件。**改名会让所有引用旧 id 的会话打不开**,
  报 `unknown agent preset: <id>`,且**不提示「它被改名了」**。
  显示名 `name` 随便改（不持久化）。2026-10-02 改名的代价是 16 个会话全删。
- 编程模式**由 dsh 本身承接**（不再自建 Electron 壳）——见 `alysia-architecture` §1.1。

## 3. 一期范围(MVP,2026-08-25)

- 插件骨架:persona section + context/variable 骨架 + `recall_memory` stub + 事件监听日志
- agent preset 可被 dsh roster 发现/选中
- **不含**:真实记忆检索、ingest 写库、server API 代写层、设置面板、QQ 适配器、编程 preset
- 验收:插件零原生依赖;dsh web 聊天呈昔涟人格;recall_memory 可调用(无 UNKNOWN_TOOL);日志见 session/event 与 session/disposed

## 4. 仍未接的范围（原「二期」清单，逐项销账）

> 原 §4 是「二期范围(另开 change)」。截至 2026-10-02 的**逐项销账**——已落地的不再留在这一节,
> 避免「已落地」被埋在「二期」措辞里（`index.md` / `HANDOFF.md` 比 spec 新的自相矛盾就是这么来的）。

| 项 | 状态 |
|---|---|
| `POST /api/ingest` 写通道 | ✅ 已落地（`connect-dsh-alysia-bridge`） |
| `GET /api/persona/prompt` 读通道 | ✅ 已落地（`connect-dsh-alysia-bridge`） |
| `POST /api/memory/read` 记忆读通道 | ✅ 已落地（`bridge-memory-read`）——**注意是 POST,不是早期设计的 GET** |
| context / `recall_memory` 换 HTTP 调用 | ✅ 已落地（`bridge-memory-read`） |
| persona 文本换成从 server 取 | ✅ 已落地（bundle 化 + `persona-variable.ts`） |
| 聊天/编程双 preset | ✅ 已落地（编程模式由 dsh 本身承接） |
| 设置面板旋钮（`installSettingsSection` 调 `memory.adjustMemoryConfig()`） | ❌ 未做 |
| 定时任务:6h `memory.cron()` + `archiveStaleSessions()`、1h 生活事件生成 | ❌ 未做——**放 server 侧**(写操作,已有基建) |
| `alysia_life` 变量（生活事件注入） | ❌ 仍是骨架（见 §2.3） |
| 其余写工具（`adjust_persona`/`switch_role`/`import_knowledge`/`list_life_events`/`set_reminder`） | ❌ 未做（见 §2.4） |
| QQ 适配器（全新 dsh 插件） | ❌ 未做（当前 QQ 仍在 server 侧 `adapters/qq-official.ts`） |
| 昔涟控制台 dsh 插件（`build-alysia-console-plugin`） | ⚠️ **进行中**。★ 2026-10-16 **更正**：原记的「踩在**已废弃的** `.agent-presets` / `tapIndex` 上」**理由不准** —— `.agent-presets` 确实废弃（且本包早已不用它，走的是 `dsh.bundle.patch`），但 `tapIndex` **没有废弃**（程序还在，dsh 文档称它是"任何行都无法表达的标记的逃生口"）。**真问题是**：桌面端 UI 不走 `renderIndex()` ⇒ **`tapIndex` 在桌面端不执行** ⇒ 入口脚本进不了页面（悬浮球不出现）。**已修**：注入改为 `webserver/index-inject` 行（`script-preload` + `script-src`@body），并加了「不再用 tapIndex」的回归守卫。**未做**：世界书/生活模板页、记忆旋钮页、审计页、`install_bundle` 装入 web profile 后的真机验收（见 §5） |
| 结算的「两段确认」服务端接口 | ❌ 未做（本 change 走适配器侧挂起重试，见 §2.5.1 契约 6；是否要服务端配合待评估） |

## 5. 与 dsh 的对接约束

- 插件不发布 root 服务(preset 内服务必须 `isolate` realm,否则 mount 拒绝)
- `{{variable}}` 严格校验;`toolOrder` 配置须含 `<unlisted-tools>` rest 标记
- 插件卸载:所有注册返回 exact disposer(Cordis effect 自动清理)
- **preset id 是持久化契约**,改名会打断已有会话(见 §2.6)
- **`~/.dsh/.agent-presets/` 目录已废弃**（2026-10-01 查证）:新版 dsh **完全不读**它
  （官方原话 "Nothing reads that directory any more.",app.asar 内无任何代码引用）。
  新机制是通过 `plugin_manager` 的 **`install_bundle`** 安装 bundle
  （`package.json` + `cordis.patch.yml`）,preset 是 `dsh-agent-preset` 的 **declaration**,
  由 bundle 的 `cordis.patch.yml` 携带 `{id, plugins, name?, description?, order?}`。
  **别再往 `.agent-presets` 写文件,也别手改 profile 的 `package.json` / `cordis.patch.yml`。**
- **桌面端与 web 端不是同一套加载**:桌面端 `resolveDesktopPaths()` 硬编码
  `~/.dsh/profiles/desktop/`,与 web profile 的插件不互通;且桌面端 UI 不走
  `renderIndex()`,`webServer.tapIndex()` **不执行**——注入要改用
  `ctx.on('webserver/index-inject', table => ...)`。`/plugins/*` 仍会转发 → 客户端 UI 插件可用。
- **persona section 名已变**:`deployment:persona` → **`deployment:persona-prefix`**（order 0）,
  另有 `deployment:persona-suffix`（order 10200）。直接用 `@deepseek-ai/dsh-persona`
  的 `config.prefix` 更稳。
- **新工具定义**推荐用 `@deepseek-ai/dsh-tools` 的 `defineTool`（`parameters` 是 spec 不是 raw JSON Schema）,
  但 `register()` 仍接受手搓 raw 定义。
- **排障最强证据源**:`~/.dsh/sessions/<工作区>/session-*/session.v4.jsonl.zstd` 是**多帧 zstd**,
  按魔数 `28 B5 2F FD` 切帧逐段解压即可 —— 里面有**模型看到的完整 system prompt**。
  背景:`docs/dsh-plugin-architecture.md`、`docs/dsh-migration-guide.md`。
- **子 agent 会话判据**：`session.header.origin === 'subagent'`
  （`SessionHeader` 的持久化字段，resume 也在；dsh `packages/core/session/src/types.ts:85`；
  `Session.header` 是公开 readonly 属性，`packages/core/session/src/index.ts:443`）。
  **不可用 `parentSession` 单独判**——`SessionStore.fork()` 也会设它、但不设 `origin`。
  **不可用 id 形状判**——主会话恰好是 `session-<uuid>`、子会话恰好是裸 `uuid`，
  那是当前命名巧合，不是契约。**不可用 scope 判**——父子共享同一 standing key。
