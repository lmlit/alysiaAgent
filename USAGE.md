# Alysia 使用手册

## 快速开始

### 1. 配置

复制 `config.example.yml` → `config.yml`，填入 API Key：

```yaml
bot:
  name: "昔涟"
  ownerId: "你的Telegram用户ID"

llm:
  baseUrl: "https://api.deepseek.com/v1"
  apiKey: "${DEEPSEEK_API_KEY}"
  model: "deepseek-v4-flash"

embed:
  baseUrl: "https://open.bigmodel.cn/api/paas/v4"
  apiKey: "${ZHIPU_API_KEY}"
  model: "embedding-2"

platforms:
  telegram:
    token: "${TELEGRAM_BOT_TOKEN}"
  # qq:                          # 取消注释启用 QQ
  #   protocol: "onebot_v11"
  #   ws_port: 6199

server:
  port: 6185
  dataDir: "./data"
  workspaceDir: "./data/workspace"
```

`.env` 文件（本地开发用）：

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-xxx
CHAT_MODEL=deepseek-v4-flash
EMBED_BASE_URL=https://open.bigmodel.cn/api/paas/v4
EMBED_API_KEY=xxx
EMBED_MODEL=embedding-2
```

### 2. 运行

```bash
# 本地 CLI 聊天
cd packages/server
npx tsx src/chat.ts

# 服务端（需要 Telegram Token）
npx tsx src/bootstrap.ts
```

### 3. Docker 部署

```bash
docker compose -f packages/server/compose.yml up -d
```

---

## 支持的平台

| 平台 | 状态 | 说明 |
|------|:---:|------|
| CLI 本地 | ✅ | 终端聊天，直接跑 `src/chat.ts` |
| Telegram | ✅ | `platforms.telegram.token` |
| QQ (OneBot v11) | ✅ | 反向 WS，支持 NapCat/LLOneBot |
| Discord | ⏳ | 规划中 |
| 微信 | ⏳ | 规划中 |

---

## 对话命令

在聊天中发送以下命令：

| 命令 | 功能 |
|------|------|
| `/new` | 新建对话 |
| `/reset` | 重置当前对话 |
| `/stats` | 查看 Token 用量 |
| `/clear` | 清空当前上下文（记忆仍保留） |
| `/exit` | 退出（仅 CLI 模式） |

---

## 目录结构

```
alysiaAgent/
├── packages/
│   ├── core/src/           # 核心逻辑
│   │   ├── memory/         # 记忆系统（7 Store）
│   │   ├── pipeline/       # 洋葱模型 Pipeline
│   │   ├── agent/          # Agent Runner
│   │   ├── platform/       # Platform 抽象
│   │   ├── provider/       # LLM Provider
│   │   ├── tools/          # Agent 工具
│   │   ├── commands/       # 聊天命令
│   │   └── persona/        # 昔涟人设文件
│   └── server/src/
│       ├── adapters/       # 平台适配器
│       ├── chat.ts         # CLI 聊天入口
│       └── bootstrap.ts    # 服务端入口
├── config.example.yml
├── Dockerfile
└── compose.yml
```

---

## Agent 工具

昔涟可以调用以下工具：

| 工具 | 功能 | 示例 |
|------|------|------|
| `shell_exec` | 执行命令 | "帮我查下当前目录有哪些文件" |
| `write_file` | 写文件 | "写个 Python 脚本画爱心" |
| `read_file` | 读文件 | "读一下刚才保存的脚本" |
| `list_files` | 浏览目录 | "看看 workspace 里有什么" |
| `web_search` | 网页搜索 | "搜索一下今天的天气" |
| `set_reminder` | 定时提醒 | "30分钟后提醒我开会" |
| `list_reminders` | 列出提醒 | "我现在有哪些提醒" |
| `cancel_reminder` | 取消提醒 | "取消第一个提醒" |

---

## 接入新平台

只需实现 `Platform` 接口，三步接入：

```typescript
// packages/server/src/adapters/my-platform.ts
import type { Platform, PlatformMetadata } from '@alysia/core/platform';

export class MyAdapter implements Platform {
  meta: PlatformMetadata = { name: 'my-platform', description: '...', id: 'my-1' };

  async run(): Promise<void> {
    // 1. 连接平台（长轮询、WebSocket、Webhook...）
  }

  async send(session: MessageSession, chain: MessageChain): Promise<void> {
    // 2. 发送消息 → 平台 API
    for (const comp of chain) {
      if (comp.type === 'plain') await api.sendMessage(session.sessionId, comp.text);
    }
  }

  // 3. 收到消息 → convert → commit_event → EventBus → Pipeline
  private onPlatformMessage(raw: unknown): void {
    const event = this.toMessageEvent(raw);
    this.eventBus.put(event);
  }
}
```

然后在 `bootstrap.ts` 注册：

```typescript
core.registerPlatform('my-platform::private', core.scheduler);
await new MyAdapter(config).run();
```

---

## 记忆系统

| Store | 功能 | 持久化 |
|-------|------|:---:|
| EventLog | 不可变事件流 | SQLite |
| Profile | 用户画像（偏好/习惯） | SQLite |
| Persona | 昔涟人格参数（3维×4参） | SQLite |
| Conversation | 对话摘要 + 向量 | SQLite + LanceDB |
| Knowledge | 外部知识 RAG | SQLite + LanceDB |
| Worldbook | 关键词触发背景故事 | SQLite |

- **人格自适应**：5道护栏自动微调语气/风格/情感
- **24h 回归**：超 24h 未使用的人格参数缓慢回归默认值
- **清空记忆**：删除 `data/alysia-chat.db` 重新开始
