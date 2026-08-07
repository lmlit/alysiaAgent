---
status: frozen
source: docs/superpowers/specs/2026-07-30-server-desktop-separation.md
migrated: 2026-08-07
---
# Alysia 服务端优化 & 桌面端接口预留 — 设计文档

> 日期: 2026-07-30
> 状态: 草稿
> 项目: alysiaAgent
> 前置: 架构重构 14 Task 全部完成、代码自检修复完成

---

## 1. 背景与动机

### 1.1 当前问题

架构重构 (Tasks 1-14) 完成后，`AlysiaCore` 是一个"全能"入口，无差别注册了所有工具和 Store。这导致：

1. **服务端启动了不该有的能力**：Telegram/QQ bot 可执行 `shell_exec`、`write_file` 等编程工具，存在安全风险
2. **没有部署模式概念**：服务端（仅聊天）和桌面端（聊天 + 编程）共用同一套初始化逻辑
3. **桌面端接口不清晰**：哪些模块是"预留接口"？哪些是"服务端专用"？没有显式契约

### 1.2 目标

| 目标 | 说明 |
|------|------|
| 服务端安全 | 编程工具（shell/filesystem）在服务端不可注册 |
| 桌面端预留 | CodeContextStore、编程工具、code 模式 Prompt 组装保留在 core 包中，桌面端按需引入 |
| 接口显式化 | 定义清晰的 `AlysiaFeatures` 配置，哪些能力启用一目了然 |
| 向后兼容 | 现有测试全部通过，MemoryManager 接口不变 |

### 1.3 非目标

- 不实现桌面端（Electron/Live2D 仍是二期）
- 不改动记忆系统核心逻辑（6 Store + 3 Engine + 3 Processor）
- 不拆分 core 包（所有能力留在 @alysia/core，通过 feature flag 控制激活）

---

## 2. 模式定义

### 2.1 两种部署模式

```
┌─────────────────────────────────────────────────────────┐
│                     @alysia/core                         │
│  ┌─────────────────────┐  ┌───────────────────────────┐ │
│  │  聊天模式 (always)    │  │  编程模式 (desktop only)    │ │
│  │  • 6 Store           │  │  • CodeContextStore        │ │
│  │  • PersonaAdapter    │  │  • shell_exec / filesystem │ │
│  │  • WorldbookMatcher  │  │  • code mode Prompt        │ │
│  │  • web_search        │  │  • project context         │ │
│  │  • reminder          │  │  • code RAG (knowledge)    │ │
│  │  • lookup_worldbook  │  │                            │ │
│  └─────────────────────┘  └───────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
   ┌──────────┐            ┌──────────────┐
   │  server  │            │   desktop     │
   │ Telegram │            │  Electron +   │
   │  + QQ    │            │  Live2D       │
   │ 仅聊天   │            │  聊天 + 编程   │
   └──────────┘            └──────────────┘
```

### 2.2 Feature 矩阵

| 能力 | 服务端 (server) | 桌面端 (desktop) | 所属模块 |
|------|:---:|:---:|------|
| 记忆系统 (6 Store) | ✅ | ✅ | core/memory |
| 人格引擎 (PersonaAdapter) | ✅ | ✅ | core/memory |
| Worldbook 匹配 | ✅ | ✅ | core/memory |
| PII 脱敏 | ✅ | ✅ | core/memory |
| 网页搜索 (web_search) | ✅ | ✅ | core/tools |
| 定时提醒 (reminder) | ✅ | ✅ | core/tools |
| Worldbook 查询工具 | ✅ | ✅ | core/tools |
| 天气查询 (weather) | ✅ | ✅ | core/tools |
| 会话命令 (/new /reset /stats) | ✅ | ✅ | core/commands |
| Shell 执行 (shell_exec) | ❌ | ✅ | core/tools |
| 文件读写 (write/read/list) | ❌ | ✅ | core/tools |
| CodeContextStore | ❌ | ✅ | core/memory |
| 编程模式 Prompt 注入 | ❌ | ✅ | core/memory |
| 知识库 RAG 导入 | ⚪ 后续 | ✅ | core/memory |
| 多 Provider 切换 | ⚪ 后续 | ✅ | core/provider |
| WebUI 管理面板 | ✅ | ❌ | server/webui |
| 流式输出 (SSE) | ✅ | ✅ | core/provider |

> ✅ = 启用, ❌ = 不启用, ⚪ = 预留后续

---

## 3. 接口设计

### 3.1 AlysiaFeatures — 能力开关

```typescript
// packages/core/src/index.ts

export interface AlysiaFeatures {
  /** 编程模式：启用 shell/filesystem 工具 + CodeContextStore + code mode prompt */
  codeMode?: boolean;
  /** Shell 执行工具（需 codeMode） */
  shell?: boolean;
  /** 文件系统工具（需 codeMode） */
  filesystem?: boolean;
  /** 知识库 RAG：PDF/URL 导入 → 向量化 → 检索 */
  knowledgeRAG?: boolean;
  /** 流式输出：LLM 响应通过 SSE 逐 token 推送 */
  streaming?: boolean;
}
```

### 3.2 AlysiaCoreOptions 扩展

```typescript
export interface AlysiaCoreOptions {
  dbPath: string;
  ownerId: string;
  workspaceDir: string;
  llmConfig: { baseUrl: string; apiKey: string; model: string };
  embedConfig: { baseUrl: string; apiKey: string; model: string };
  // ★ 新增
  features?: AlysiaFeatures;
}
```

### 3.3 AlysiaCore 注册方法拆分

```typescript
export class AlysiaCore {
  // ... existing fields ...

  async start(): Promise<void> {
    // 1. Database + Memory（始终初始化）
    await this.initDatabase();
    await this.initMemory();

    // 2. Provider（始终初始化）
    this.initProvider();

    // 3. 按 feature flag 注册工具
    this.registerChatTools();        // 聊天工具：始终注册
    if (this.opts.features?.codeMode) {
      this.registerCodeTools();      // 编程工具：仅桌面端
    }

    // 4. Commands（始终注册）
    this.registerCommands();

    // 5. Pipeline + EventBus（始终初始化）
    await this.initPipeline();
  }

  /** 聊天工具：服务端 + 桌面端都注册 */
  private registerChatTools(): void {
    this.toolRegistry.register(createWebSearchTool());
    this.toolRegistry.register(createWeatherTool());
    this.toolRegistry.register(createWorldbookTool(db));
    this.toolRegistry.register(createReminderTool(notifyFn));
    this.toolRegistry.register(createListRemindersTool());
    this.toolRegistry.register(createCancelReminderTool());
  }

  /** ★ 编程工具：仅桌面端调用。标记为 public，桌面端也可手动追加 */
  registerCodeTools(): void {
    if (this.opts.features?.shell !== false) {
      this.toolRegistry.register(createShellExecTool(this.opts.workspaceDir));
    }
    if (this.opts.features?.filesystem !== false) {
      this.toolRegistry.register(createWriteFileTool(this.opts.workspaceDir));
      this.toolRegistry.register(createReadFileTool(this.opts.workspaceDir));
      this.toolRegistry.register(createListFilesTool(this.opts.workspaceDir));
    }
  }
}
```

### 3.4 桌面端预留接口清单

以下模块在 `@alysia/core` 中保持导出，桌面端直接 import 即可使用：

| 导出路径 | 用途 | 桌面端如何使用 |
|----------|------|---------------|
| `@alysia/core/memory` → `CodeContextStore` | 项目上下文 CRUD | 初始化 + Pipeline Stage 注入 |
| `@alysia/core/tools` → `createShellExecTool(dir)` | Shell 执行 | `core.toolRegistry.register(...)` |
| `@alysia/core/tools` → `createWriteFileTool(dir)` | 文件写入 | 同上 |
| `@alysia/core/tools` → `createReadFileTool(dir)` | 文件读取 | 同上 |
| `@alysia/core/tools` → `createListFilesTool(dir)` | 文件列表 | 同上 |
| `@alysia/core/memory` → `PromptAssembler.assemble('code')` | 编程模式 Prompt | MemoryRetrievalStage 切换到 code mode |
| `@alysia/core` → `AlysiaCore.registerCodeTools()` | 批量注册编程工具 | 桌面端启动时调用 |

### 3.5 桌面端预期启动代码（伪代码，二期实现）

```typescript
// packages/desktop/src/bootstrap.ts (二期)
import { AlysiaCore } from '@alysia/core';

const core = new AlysiaCore({
  dbPath: './data/alysia.db',
  ownerId: 'local-user',
  workspaceDir: './data/workspace',
  llmConfig: { /* ... */ },
  embedConfig: { /* ... */ },
  features: {
    codeMode: true,     // ★ 启用编程模式
    shell: true,
    filesystem: true,
    streaming: true,    // Live2D 口型同步需要流式
  },
});

await core.start();
// CodeContextStore 已激活，shell/filesystem 工具已注册
// PromptAssembler.assemble('code') 可用
```

---

## 4. Pipeline 模式切换

### 4.1 当前问题

`MemoryRetrievalStage` 和 `LLMAgentStage` 硬编码 `mode: 'chat'`，无法切换到 code 模式。

### 4.2 改造方案

`MessageEvent` 上新增 `pipelineMode` 字段：

```typescript
// platform/event.ts
export class MessageEvent {
  // ... existing ...
  
  /** Pipeline 模式：chat = 聊天模式，code = 编程模式。默认 chat */
  pipelineMode: 'chat' | 'code' = 'chat';
}
```

`MemoryRetrievalStage` 读取该字段：

```typescript
// pipeline/stages/memory-retrieval.ts
async process(event: MessageEvent): Promise<void> {
  const mode = event.pipelineMode; // 'chat' | 'code'
  const systemPrompt = await this.memoryManager.assemble(mode);
  event.setExtra('memory_context', systemPrompt);
}
```

服务端始终为 `'chat'`，桌面端根据用户切换发送 `'code'`。

### 4.3 Worldbook scope 联动

编程模式下 Worldbook 匹配自动切换到 `scope='code' | 'both'`：

```typescript
// memory/engines/WorldbookMatcher.ts — mode 参数已支持，无需改动
await this.worldbookMatcher.match(text, mode); // 'chat' | 'code'
```

---

## 5. 服务端优化清单

以下优化仅影响服务端，不影响 core 包对外接口：

| # | 优化项 | 说明 |
|---|--------|------|
| 1 | **Features 默认关闭编程模式** | `AlysiaFeatures.codeMode` 默认 `false` |
| 2 | **bootstrap.ts 精简** | 仅注册聊天工具，不暴露 shell/filesystem |
| 3 | **config.yml 增加 features 段** | `features: { codeMode: false }` 显式声明 |
| 4 | **Telegram/QQ adapter 安全加固** | 消息长度限制、频率限制（后续 PR） |
| 5 | **流式输出 Pipeline 接入** | LLMAgentStage 改用 `textChatStream`（后续 PR） |
| 6 | **WebUI 管理面板** | Fastify + Vue SPA，查看会话/Token/人格状态（后续 PR） |

---

## 6. 实施计划

### Phase 1: Feature Flag 系统（本次）

- [ ] 1.1 定义 `AlysiaFeatures` 接口
- [ ] 1.2 `AlysiaCoreOptions` 增加 `features?` 字段
- [ ] 1.3 `AlysiaCore.start()` 按 features 分流注册工具
- [ ] 1.4 拆分 `registerChatTools()` / `registerCodeTools()`
- [ ] 1.5 `MessageEvent` 增加 `pipelineMode` 字段
- [ ] 1.6 `MemoryRetrievalStage` 读取 `pipelineMode`
- [ ] 1.7 `bootstrap.ts` 显式设置 `features: { codeMode: false }`
- [ ] 1.8 `config.ts` / `config.example.yml` 增加 features 配置段
- [ ] 1.9 运行全部 187 个测试，确保通过

### Phase 2: 服务端优化（后续 PR）

- [ ] 2.1 流式输出 Pipeline 接入（textChatStream → RespondStage SSE）
- [ ] 2.2 `/stop` 命令实现
- [ ] 2.3 空 @ 处理
- [ ] 2.4 群聊上下文注入 (system_reminder)
- [ ] 2.5 WebUI 管理面板骨架 (Fastify + health endpoint)

### Phase 3: 桌面端基础（二期）

- [ ] 3.1 `packages/desktop/` 脚手架
- [ ] 3.2 Electron 壳 + IPC 桥接
- [ ] 3.3 `features: { codeMode: true }` 启动
- [ ] 3.4 Live2D 渲染集成

---

## 7. 测试策略

| 测试类型 | 内容 | 预期 |
|----------|------|------|
| 单元测试 | Feature flag 各组合的注册逻辑 | 187 现有测试 + 新增 feature flag 测试 |
| 集成测试 | `features.codeMode=true/false` 下 Pipeline 全链路 | chat 模式正常，code 模式工具注册 |
| 手动验证 | server bootstrap 启动，确认 shell_exec 不可用 | Telegram bot 无法执行命令 |

---

## 8. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-30 | 初始设计：Feature flag 系统 + 服务端/桌面端分离 + 接口预留 |
