# dsh-adapter — DSH 插件适配层

> 把 Alysia 昔涟人格/记忆系统接入 DeepSeek Harness(dsh)。dsh 提供聊天/编程 UI、agent 循环、LLM 适配、工具管线;本层把 alysia 的核心资产(人格、记忆、世界书、生活事件)以 cordis 插件形态注入。
> 背景:`docs/dsh-migration-guide.md` §5(迁移对接建议)。

## 1. 概述

- **形态**:cordis 插件(`name` + `Config` schemastery schema + `apply(ctx, config)`),打包为 `packages/dsh-adapter`,通过 agent-preset composition 绝对路径加载,不侵入 dsh 源码树
- **职责边界**:dsh 负责 UI/agent 循环/LLM/工具执行;插件负责「昔涟人格 section + 记忆 context + 生活事件 variable + alysia 工具 + 消息 ingest hook」
- **进程模型**:双进程。server 进程(QQ 适配器/LifeService/Fastify)为记忆权威写入者;dsh 进程内插件为只读消费者,所有写操作经 server Fastify API 代写(二期)

## 2. 关键机制

### 2.1 Persona 注入(替代 PromptAssembler 的 chat 模式)

- 注册 `systemPrompt.section({name: PERSONA_SECTION, order: PERSONA_ORDER, ...})` 影子覆盖部署 persona(`@deepseek-ai/dsh-system-prompt` 导出常量,不硬编码)
- 一期:内置昔涟人设文本(与 `PromptAssembler` chat 模式基调一致);二期:provider 内调 server API 取 `memory.getActiveSystemPrompt()`
- `complete: true` 可完全接管 sections(不影响 contexts/tools/variables 组装),后续按需启用

### 2.2 记忆 context(替代 MemoryRetrievalStage)

- `systemPrompt.context({name: 'alysia:memory', text: provider})` 注入检索结果快照
- **AssembleContext 不含用户消息**(只有 `{scope?, signal?}`)——插件缓存最近一次 `session/event` 的 `user/message` 文本,作为检索 query
- 一期返回空字符串(骨架);二期 provider 内调 server API `GET /api/memory/read`

### 2.3 生活事件 variable

- `systemPrompt.variable('alysia_life', provider)` 注册 `{{alysia_life}}`
- **严格校验**:模板引用未注册/未提供值的变量 → assembly 直接 throw;一期不引用即安全,二期 provider 调 `memory.getLifeEventInjection()`

### 2.4 工具注册(替代 ToolRegistry)

- `ctx.tools.register(ToolDefinition)` —— **硬约束**:必须带 `output {schema, render, presentationMeta?}`,参数/返回值 lossless JSON,execute 协作 `exec.signal`
- 一期:`recall_memory`(stub);二期工具表全部走 server API 代写:`recall_memory`/`adjust_persona`/`switch_role`/`import_knowledge`/`list_life_events`/`set_reminder`

### 2.5 消息 ingest hook(替代 MemoryIngestStage / SessionEndProcessor)

| dsh 事件 | 用途 |
|---|---|
| `session/event`(type=`user/message`) | 用户消息 → `memory.ingest()`(二期经 API) |
| `session/event`(type=`assistant/message`) | AI 回复回写 |
| `session/disposed` | 会话结束 → `memory.onSessionEnd()` |

- 插件在 preset 内挂载 → scoped 监听天然只收本 agent 事件
- 二期:写操作走 server `POST /api/ingest` 代写(WAL 一写多读,避免双写 SQLITE_BUSY)

### 2.6 Agent preset(聊天/编程双模式)

- 一期:chat preset(`presets/alysia/`),composition = alysia-adapter 行 + 最小 chat 工具集
- 二期:编程 preset(对照 dsh 功能面,注册 shell/filesystem 等 dsh 既有工具 + code-mode)

## 3. 一期范围(MVP,2026-08-25)

- 插件骨架:persona section + context/variable 骨架 + `recall_memory` stub + 事件监听日志
- agent preset 可被 dsh roster 发现/选中
- **不含**:真实记忆检索、ingest 写库、server API 代写层、设置面板、QQ 适配器、编程 preset
- 验收:插件零原生依赖;dsh web 聊天呈昔涟人格;recall_memory 可调用(无 UNKNOWN_TOOL);日志见 session/event 与 session/disposed

## 4. 二期范围(另开 change)

- server API 代写层:`GET /api/memory/read`、`POST /api/ingest`、写工具端点(对照 `docs/Web-API-Design.md`)
- context/tool 实现换 HTTP 调用;persona 文本换 server 取
- 设置面板旋钮(`installSettingsSection` 调 `memory.adjustMemoryConfig()`)
- 定时任务:6h `memory.cron()` + `archiveStaleSessions()`、1h 生活事件生成 —— **放 server 侧**(写操作,已有基建)
- 聊天/编程双 preset;QQ 适配器(全新 dsh 插件)

## 5. 与 dsh 的对接约束

- 插件不发布 root 服务(preset 内服务必须 `isolate` realm,否则 mount 拒绝)
- `{{variable}}` 严格校验;`toolOrder` 配置须含 `<unlisted-tools>` rest 标记
- 插件卸载:所有注册返回 exact disposer(Cordis effect 自动清理)
