# Alysia 架构设计文档

> 日期: 2026-07-20
> 状态: 已确认
> 项目: alysiaAgent
> 参考: AstrBot (https://github.com/AstrBotDevs/AstrBot)

---

## 1. 概述

### 1.1 定位

Alysia 从"桌面 AI Agent"重新定位为**有记忆、有人格的 AI 伴侣**。砍掉 Coding/编程模式，聚焦聊天体验。

架构上借鉴 AstrBot 的 Platform 抽象 + Pipeline 洋葱模型 + EventBus，用 TypeScript monorepo 实现一套核心逻辑驱动多个端（服务端、桌面端）。

### 1.2 系统边界

| 范围内 | 范围外 |
|--------|--------|
| Pipeline 洋葱模型消息处理 | Live2D 渲染（二期） |
| Platform 抽象 + Telegram Adapter | 代码执行/Shell 沙箱 |
| EventBus 事件总线 | Electron 桌面壳（二期） |
| Agent Runner (tool-loop) | QQ/微信/Discord 平台（二期） |
| 记忆系统接入 (6 Store) | 代码上下文 (CodeContextStore 已砍) |
| 人格引擎 + 护栏 | |
| Token 统计 | |
| LLM Provider 抽象 | |
| 知识库 RAG | |
| 轻量工具 (搜索/提醒) | |
| 会话管理命令 | |
| Docker 部署 | |
| WebUI 管理面板 | |

### 1.3 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| 语言 | TypeScript (Node.js) | 现有记忆系统语言，Electron 兼容 |
| 包管理 | pnpm workspace | monorepo 原生支持 |
| Telegram SDK | telegraf | 最成熟的 Node.js Telegram Bot 框架 |
| WebUI 后端 | Fastify | 高性能、TypeScript 友好 |
| WebUI 前端 | Vue.js SPA | 轻量、现有经验 |
| 定时任务 | node-cron | 轻量，MVP 够用 |
| 部署 | Docker + compose | 一键部署 |
| 数据库 | better-sqlite3 + LanceDB | ★ 现有，不改 |
| LLM Provider | OpenAI 协议兼容 | ★ 现有双 provider 架构，扩展为多 provider |

---

## 2. 工程结构

### 2.1 Monorepo 布局

```
alysia/
├── packages/
│   ├── core/                      # @alysia/core
│   │   ├── src/
│   │   │   ├── memory/            # ★ 现有代码，不动
│   │   │   │   ├── types.ts
│   │   │   │   ├── database.ts
│   │   │   │   ├── MemoryManager.ts
│   │   │   │   ├── PromptAssembler.ts
│   │   │   │   ├── PIIFilter.ts
│   │   │   │   ├── TokenBudget.ts
│   │   │   │   ├── interfaces/
│   │   │   │   ├── services/
│   │   │   │   ├── stores/
│   │   │   │   ├── engines/
│   │   │   │   └── processors/
│   │   │   ├── pipeline/          # 新增
│   │   │   │   ├── types.ts       # Stage 接口 + PipelineContext
│   │   │   │   ├── scheduler.ts   # PipelineScheduler (洋葱循环)
│   │   │   │   ├── context.ts     # PipelineContext 实现
│   │   │   │   └── stages/        # 内置 Stage 实现
│   │   │   │       ├── pii-filter.ts
│   │   │   │       ├── memory-ingest.ts
│   │   │   │       ├── worldbook.ts
│   │   │   │       ├── memory-retrieval.ts
│   │   │   │       ├── llm-agent.ts
│   │   │   │       └── respond.ts
│   │   │   ├── platform/          # 新增
│   │   │   │   ├── types.ts       # Platform / PlatformMetadata / MessageSession
│   │   │   │   ├── event.ts       # MessageEvent 统一消息事件
│   │   │   │   ├── message.ts     # Message / MessageComponent
│   │   │   │   └── chain.ts       # MessageChain
│   │   │   ├── eventbus/          # 新增
│   │   │   │   └── EventBus.ts    # AsyncQueue + dispatch 循环
│   │   │   ├── agent/             # 新增
│   │   │   │   ├── runner.ts      # ToolLoopAgentRunner
│   │   │   │   ├── context.ts     # 上下文管理 + 压缩
│   │   │   │   └── hooks.ts       # Agent 生命周期钩子
│   │   │   ├── provider/          # 新增 (扩展现有 services/)
│   │   │   │   ├── types.ts       # Provider 抽象接口
│   │   │   │   ├── openai.ts      # OpenAI 协议兼容 provider
│   │   │   │   └── fallback.ts    # Provider 降级链
│   │   │   ├── tools/             # 新增
│   │   │   │   ├── registry.ts    # 工具注册表
│   │   │   │   ├── web-search.ts  # 网页搜索
│   │   │   │   └── reminder.ts    # 定时提醒
│   │   │   └── index.ts           # AlysiaCore 统一入口
│   │   └── package.json
│   │
│   ├── server/                    # @alysia/server
│   │   ├── src/
│   │   │   ├── adapters/
│   │   │   │   ├── telegram.ts    # TelegramAdapter
│   │   │   │   └── webchat.ts     # WebChatAdapter (WebUI 内嵌聊天)
│   │   │   ├── webui/
│   │   │   │   ├── server.ts      # Fastify 启动
│   │   │   │   ├── api/           # REST API 路由
│   │   │   │   └── dist/          # Vue.js SPA 静态文件
│   │   │   ├── config.ts          # 配置加载
│   │   │   └── bootstrap.ts       # 启动入口
│   │   ├── Dockerfile
│   │   ├── compose.yml
│   │   └── package.json
│   │
│   └── desktop/                   # @alysia/desktop (二期)
│       └── ...
│
├── pnpm-workspace.yaml
└── tsconfig.json
```

### 2.2 策略：方案 A — 包装模式

- **现有记忆系统代码零改动**，MemoryManager 接口保持不变
- Pipeline Stage 作为薄包装层调用 MemoryManager
- 130 个现有测试全部保留，新增 Pipeline/Agent 测试
- Stage 接口设计时预留细粒度拆分扩展点

---

## 3. Core 四大接口

### 3.1 Platform — 平台适配器

```typescript
interface Platform {
  meta: PlatformMetadata;
  run(): Promise<void>;
  send(session: MessageSession, chain: MessageChain): Promise<void>;
  terminate?(): Promise<void>;
}

interface PlatformMetadata {
  name: string;           // 'telegram' | 'webchat' | 'electron-ipc'
  description: string;
  id: string;             // 唯一实例 ID (同类型可能多实例)
}
```

每个 Platform 负责：
- **收**：平台消息 → MessageEvent → `eventQueue.put(event)`
- **发**：`send(session, chain)` → 平台 API 调用

### 3.2 Stage — Pipeline 阶段（洋葱模型）

```typescript
interface Stage {
  initialize(ctx: PipelineContext): Promise<void>;
  process(event: MessageEvent): Promise<void> | AsyncGenerator<void, void, void>;
  // 返回 Promise → 顺序执行
  // 返回 AsyncGenerator → 洋葱嵌套 (yield = 内层执行完毕)
}
```

`PipelineContext` 注入全局依赖：
```typescript
interface PipelineContext {
  memoryManager: MemoryManager;
  providerManager: ProviderManager;
  toolRegistry: ToolRegistry;
  config: AlysiaConfig;
}
```

### 3.3 MessageEvent — 统一消息事件

```typescript
class MessageEvent {
  messageStr: string;
  messageObj: Message;
  session: MessageSession;         // "telegram:group:chat-123"
  platformMeta: PlatformMetadata;

  // 统一查询 API
  getSenderId(): string;
  getSenderName(): string;
  getMessageType(): MessageType;   // PRIVATE | GROUP
  getGroupId(): string;
  isStopped(): boolean;
  stopEvent(): void;

  // 数据携带
  setExtra(key: string, value: unknown): void;
  getExtra(key: string): unknown;

  // 发送 + LLM 请求 (由 Platform 代理实现)
  send(chain: MessageChain): Promise<void>;
  requestLLM(prompt: string, opts?: LLMOptions): ProviderRequest;
}
```

### 3.4 EventBus — 事件总线

```typescript
class EventBus {
  private queue: AsyncQueue<MessageEvent>;
  private schedulerMapping: Map<string, PipelineScheduler>;  // confId → scheduler

  async dispatch(): Promise<void>;  // 无限循环取事件 → 路由 Pipeline
}
```

核心逻辑：`dispatch()` 从 AsyncQueue 阻塞取事件，根据 `event.session` 路由到对应的 `PipelineScheduler`。单进程内用内存队列，未来可替换为 Redis Streams 支持多进程。

---

## 4. Pipeline 设计

### 4.1 PipelineScheduler（约 60 行）

```typescript
class PipelineScheduler {
  private stages: Stage[];

  async execute(event: MessageEvent): Promise<void> {
    await this.processStages(event, 0);
  }

  private async processStages(event: MessageEvent, from: number): Promise<void> {
    for (let i = from; i < this.stages.length; i++) {
      const result = this.stages[i].process(event);

      if (isAsyncGenerator(result)) {
        for await (const _ of result) {
          if (event.isStopped()) break;
          await this.processStages(event, i + 1);  // 递归 → 内层
          if (event.isStopped()) break;
        }
      } else {
        await result;
        if (event.isStopped()) break;
      }
    }
  }
}
```

`isAsyncGenerator()` 判断：检查 `result[Symbol.asyncIterator]` 是否存在。

### 4.2 MVP Pipeline 编排

```
Stage                 模式      职责
──────────────────────────────────────────────────
PIIFilterStage        async     脱敏手机号/身份证 → event.messageStr
MemoryIngestStage     async     MemoryManager.ingest(event)
                                → RealtimeProcessor (Worldbook + embed)
                                → 群聊: NPC 跳过画像提取
WorldbookStage        async     关键词匹配 → 注入世界书条目
MemoryRetrievalStage  async     MemoryManager.assemble(session)
                                → System Prompt (人格+画像+摘要+Worldbook)
LLMAgentStage        *洋葱*     前置: ProviderRequest → Agent Runner tool-loop
                                yield ────────────→ RespondStage
                                后置: Token 统计 + 会话长度检查 + 人格扫描
RespondStage          async     发送消息到平台
```

### 4.3 群聊 NPC 模式

```typescript
// MemoryIngestStage 内部
async process(event: MessageEvent): Promise<void> {
  await this.memory.ingest(event);  // 所有人写入 EventLog

  const isGroup = event.getMessageType() === MessageType.GROUP;
  const ownerId = this.config.ownerId;

  if (!isGroup || event.getSenderId() === ownerId) {
    await this.memory.processProfile(event);  // 仅 owner 建画像
  }
  // NPC 的消息保留为流水账，不提取 Profile
}
```

### 4.4 Token 统计（LLMAgent 洋葱后置）

```typescript
class LLMAgentStage implements Stage {
  async *process(event: MessageEvent): AsyncGenerator<void> {
    const startTime = Date.now();
    let tokenUsage: TokenUsage = { input: 0, output: 0 };

    // === 前置: LLM 调用 ===
    const response = await this.runner.run(event, {
      onUsage: (usage) => { tokenUsage = usage; },
    });

    event.setExtra('llm_response', response);
    yield;  // ─────→ RespondStage 发消息 ─────→

    // === 后置: Token 统计 ===
    await this.db.recordTokenUsage({
      sessionId: event.session.toString(),
      conversationId: event.getExtra('conversationId'),
      ...tokenUsage,
      duration: Date.now() - startTime,
    });

    // 会话长度检查 → 触发摘要
    if (this.runner.contextLength > this.config.maxContextTokens * 0.8) {
      await this.memory.onSessionEnd(event.session.toString());
    }

    // 人格信号扫描
    await this.memory.scanPersonaSignals(event);
  }
}
```

---

## 5. Telegram Adapter 设计

### 5.1 消息转换

```typescript
class TelegramAdapter implements Platform {
  private bot: Telegraf;

  // Telegram 消息 → MessageEvent
  private toMessageEvent(ctx: Context): MessageEvent {
    const msg = ctx.message!;
    const chatType = msg.chat.type === 'private'
      ? MessageType.PRIVATE
      : MessageType.GROUP;

    const message: Message = {
      sessionId: String(msg.chat.id),
      groupId: chatType === MessageType.GROUP ? String(msg.chat.id) : '',
      sender: {
        userId: String(msg.from!.id),
        nickname: msg.from!.first_name || 'Unknown',
      },
      messageId: String(msg.message_id),
      type: chatType,
      raw: ctx,
      content: this.parseContent(msg),
    };

    return new MessageEvent({
      messageStr: 'text' in msg ? (msg.text || '') : '',
      messageObj: message,
      platformMeta: this.meta(),
      sessionId: message.sessionId,
    });
  }

  // 发送: MessageChain → Telegram API
  async send(session: MessageSession, chain: MessageChain): Promise<void> {
    const chatId = session.sessionId;
    for (const comp of chain) {
      switch (comp.type) {
        case 'plain':
          await this.bot.telegram.sendMessage(chatId, comp.text);
          break;
        case 'image':
          await this.bot.telegram.sendPhoto(chatId, comp.url);
          break;
        // ...
      }
    }
  }
}
```

### 5.2 支持的消息类型

| Telegram 类型 | MessageComponent | 方向 |
|--------------|-----------------|------|
| text | Plain | 收/发 |
| photo | Image | 收/发 |
| voice | Voice | 收 |
| sticker | Sticker → Plain("[Sticker: xxx]") | 收 |
| document | File | 收 |
| video | Video | 收 |
| reply | Reply | 收 |
| mention (@) | At | 收 |
| keyboard | QuickReply (按钮) | 发 |

---

## 6. Agent Runner 设计

### 6.1 Tool-Loop 流程

```
用户消息
  → assemble System Prompt (记忆系统)
  → 发送到 LLM
  → LLM 返回:
      ├── 文本回复 → 完成，发给用户
      └── 工具调用 → 执行工具 → 结果注入上下文 → 回到 "发送到 LLM"
                      ↑                               │
                      └──── 循环 (max N 次) ──────────┘
```

### 6.2 内置工具

| 工具 | 描述 | 实现 |
|------|------|------|
| web_search | 搜索网页并返回摘要 | SerpAPI / Bing API |
| set_reminder | 设置定时提醒 | node-cron + 到时 @用户 |
| list_reminders | 列出当前提醒 | 查询 cron 任务表 |
| cancel_reminder | 取消提醒 | 删除 cron 任务 |

### 6.3 会话管理命令

| 命令 | 功能 |
|------|------|
| `/new` | 新建对话，清空上下文 |
| `/reset` | 重置当前对话，保留人格设置 |
| `/stop` | 停止正在运行的 Agent (中断生成) |
| `/stats` | 查看当前会话 Token 用量 |

---

## 7. 部署

### 7.1 Dockerfile

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY packages/core/dist ./packages/core/dist
COPY packages/server/dist ./packages/server/dist
COPY node_modules ./node_modules
EXPOSE 6185
CMD ["node", "packages/server/dist/bootstrap.js"]
```

### 7.2 compose.yml

```yaml
services:
  alysia:
    build: .
    container_name: alysia-server
    restart: always
    ports:
      - "6185:6185"
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/app/data
      - ./config.yml:/app/config.yml
```

### 7.3 配置示例 (config.yml)

```yaml
bot:
  name: "昔涟"
  ownerId: "123456789"  # Telegram user ID

llm:
  primary:
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "${DEEPSEEK_API_KEY}"
    model: "deepseek-v4-flash"
  embedding:
    baseUrl: "https://open.bigmodel.cn/api/paas/v4"
    apiKey: "${ZHIPU_API_KEY}"
    model: "embedding-2"

platforms:
  telegram:
    token: "${TELEGRAM_BOT_TOKEN}"

server:
  port: 6185
  webui: true
```

---

## 8. 数据流全景

```
Telegram API ──→ TelegramAdapter.onMessage()
                      │
                      ▼ convert_message()
              ┌──────────────────┐
              │   MessageEvent   │
              └──────┬───────────┘
                     │ eventQueue.put()
                     ▼
              ┌──────────────┐
              │   EventBus   │
              │  dispatch()  │
              └──────┬───────┘
                     ▼
         PipelineScheduler.execute(event)
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
  PIIFilter    MemoryIngest    Worldbook
      │              │              │
      └──────────────┼──────────────┘
                     ▼
              MemoryRetrieval ──→ System Prompt
                     │
                     ▼
              LLMAgent (洋葱)
              前置: LLM + Tools
              yield ────→ Respond ────→ Telegram API 📤
              后置: Token + 摘要 + 人格
```

---

## 9. MVP 功能清单（定版）

### P0 — 必须做

| 模块 | 功能 |
|------|------|
| Telegram Bot | Platform Adapter，收发消息 |
| 多轮对话 | LLM Provider + Agent Runner，流式输出 |
| 记忆系统 | 6 Store 全量 (EventLog, Profile, Persona, Conversation, Knowledge, Worldbook) |
| 人格 | 昔涟人设 + PersonaAdapter 5 道护栏 |
| 群聊 NPC | Owner 建画像，NPC 仅流水账 |
| Token 统计 | `/stats` + LLMAgent 后置自动记录 |
| 会话管理 | `/new` `/reset` `/stop` |
| Pipeline | 6 Stage 洋葱编排 |
| EventBus | AsyncQueue 事件分发 |
| Docker | compose.yml 一键部署 |

### P1 — 让 bot 更完整

| 模块 | 功能 |
|------|------|
| 空 @ 处理 | @bot 没说话 → bot 询问 |
| 群聊上下文 | 发言间隙消息注入 system_reminder |
| 知识库 RAG | PDF/URL → 向量检索 |
| 网页搜索 | Agent 工具 |
| 定时提醒 | `/remind 30min 内容` |
| WebUI | Fastify + Vue SPA 管理面板 |

### P2 — 二期

| 模块 | 功能 |
|------|------|
| 主动回复 | 概率掷骰子接话 |
| 更多平台 | QQ / Discord / 微信 |
| Desktop | Electron + Live2D |

---

## 10. 与 AstrBot 的借鉴对照

| 借鉴点 | AstrBot | Alysia |
|--------|---------|--------|
| Platform 抽象 | `Platform` 基类 + 装饰器注册 | TypeScript `interface Platform` + 手动注册 |
| Pipeline 洋葱 | `process()` 返回 `None \| AsyncGenerator` | 同款，`Symbol.asyncIterator` 判断 |
| EventBus | `asyncio.Queue` 单进程循环 | Node.js `AsyncQueue` |
| Agent Runner | `ToolLoopAgentRunner` (~1500行) | TypeScript 简化版 |
| Provider 抽象 | 20+ provider 统一接口 | OpenAI 协议兼容 + fallback 链 |
| Stage 注册 | `register_stage` 装饰器 | 数组 push 手动注册 |
| 插件系统 | Star 架构 | 不借鉴 (MVP 不需要) |
| 代码沙箱 | Shipyard Docker-in-Docker | 不需要 (砍掉了) |
