# alysiaAgent — Project Context

## What We're Building

AI Agent 桌面应用：聊天模式 + 编程模式，搭载"昔涟"人格和记忆系统。
- 聊天模式：Live2D 角色 + 对话，AI 自行调整人格
- 编程模式：类似 Claude Code，携带聊天模式积累的人格/记忆

## ★ 开发约束：Web 端接口兼容（必读）

后续开发**服务端功能**时，新增/修改 core 方法必须先对照 `docs/Web-API-Design.md`：

1. Web 端需要的功能（会话/画像/人格/Token/知识库/平台状态）必须在 **MemoryManager 或 AlysiaCore 暴露公开方法**，不在 pipeline/adapter 内部闭包
2. 方法返回**纯数据**（JSON 可序列化），不返回 DB 句柄/类实例
3. 命名：`get*Snapshot()` 只读 / `list*()` 列表 / `extract*()` LLM 提取 / `adjust*()` 带护栏调整 / `import*()` 导入
4. 新增方法要同步更新 `docs/Web-API-Design.md` 第 2/3 节状态标记

**目的**：避免 Web 端开发时回来改服务端接口、重复回归测试。

## Current State

**记忆系统核心已完成 (28 源文件, 187 测试)**

### Tech Stack
- TypeScript + better-sqlite3 (WAL) + LanceDB (嵌入式向量库)
- 测试: Vitest, 121 单元/集成 + 2 E2E (真实 API) + 1 Cron

### API 配置 (.env, 已 gitignore)
- Chat/LLM: DeepSeek deepseek-v4-flash
- Embedding: 智谱 embedding-2 (1024 维)
- 架构支持双 provider，Chat Base URL / Embed Base URL 分离
- OpenAI 协议兼容，切 provider 只改 .env

### 文件结构
```
src/memory/
├── types.ts                    # 所有类型 + 位掩码常量
├── database.ts                 # 7 表 schema + 默认行种子
├── MemoryManager.ts            # 统一入口 (ingest/read/assemble/onSessionEnd/cron)
├── PromptAssembler.ts          # 双模式 System Prompt (chat ≤3200, code ≤2450 tokens)
├── PIIFilter.ts                # 手机/身份证/银行卡脱敏
├── TokenBudget.ts              # CJK 感知 token 估算
├── interfaces/
│   ├── IVectorStore.ts         # 向量存储抽象 (本地/远端切换)
│   ├── IEmbedService.ts        # 嵌入 API
│   └── ILLMService.ts          # LLM 调用
├── services/                   # ★ OpenAI 协议通用服务
│   ├── config.ts               # 双 provider 配置
│   ├── OpenAIEmbedService.ts   # /v1/embeddings
│   ├── OpenAILLMService.ts     # /v1/chat/completions
│   └── index.ts
├── stores/                     # 7 个 Store
│   ├── EventStore.ts           # 不可变事件日志
│   ├── ProfileStore.ts         # 用户画像 (facts + basics)
│   ├── PersonaStore.ts         # AI 人格 (tone/speech/emotional + 护栏)
│   ├── ConversationStore.ts    # 对话摘要 + 向量
│   ├── KnowledgeStore.ts       # 知识库 RAG
│   ├── WorldbookStore.ts       # 情境触发 (关键词 + 冷却)
│   └── CodeContextStore.ts     # 项目上下文
├── engines/                    # 3 个智能引擎
│   ├── ProfileExtractor.ts     # LLM 提取事实 → dedup merge
│   ├── PersonaAdapter.ts       # 5 道安全护栏 (|Δ|≤0.1, 5min冷却, 3次上限, 24h回归, 显式bypass)
│   └── WorldbookMatcher.ts     # 关键词匹配 + 冷却
└── processors/                 # 3 个时间维度
    ├── RealtimeProcessor.ts    # 每条消息后
    ├── SessionEndProcessor.ts  # 会话关闭 (摘要+画像+人格)
    └── CronProcessor.ts        # 定时 (压缩+深度画像+清理)
```

### 记忆系统数据流
```
用户消息 → MemoryManager.ingest()
  → PII 脱敏 → Event Log (不可变)
  → RealtimeProcessor: Worldbook 匹配 + 人格扫描 + 嵌入生成
  → 会话关闭: SessionEndProcessor (LLM 摘要 + 画像提取 + 人格确认)
  → 定时: CronProcessor (深度画像重写 → basics 自然语言)
  → MemoryManager.assemble() → System Prompt 注入
```

### 人格自适应
- 3 维度 × 4 参数: tone/speech_style/emotional_range
- 5 道护栏: |Δ|≤0.1 / 5min 冷却 / ≤3 次同向 / 24h 回归 / 显式指令 bypass
- 自动从用户消息中检测偏好信号

### Git 推送
- Clash 代理: 127.0.0.1:7890，推送前需开启
- Skill: `/clash-proxy` 或直接:
  ```bash
  git config --global http.proxy http://127.0.0.1:7890
  git config --global https.proxy http://127.0.0.1:7890
  # 推送后关闭
  git config --global --unset http.proxy
  git config --global --unset https.proxy
  ```

### Skills 仓库
- `https://github.com/lmlit/my-claude-skills` (公开)
- 本地: `E:\workSpace\my-claude-skills\`
- 全局 skills: `~/.claude/skills/` (superpowers 14 个 + clash-proxy)

## Current State

**记忆系统核心 + 架构重构 + Feature Flag 全部完成 (187 测试通过)**

### 新增：AlysiaFeatures 能力开关
- `codeMode` / `shell` / `filesystem` / `streaming` flags
- 服务端: `features: { codeMode: false }` — 仅聊天工具
- 桌面端: `features: { codeMode: true }` — 全量工具 + CodeContextStore
- `MessageEvent.pipelineMode` — 'chat'|'code' 控制 Prompt 组装模式

## Next: 服务端优化

待做:
1. 流式输出 Pipeline 接入 (LLMAgentStage → textChatStream)
2. `/stop` 命令 + 空 @ 处理 + 群聊 system_reminder
3. WebUI 管理面板 (Fastify + Vue SPA)
4. 桌面端 (Electron + Live2D, features.codeMode=true)

## 环境变量 (.env)
> 实际 key 在项目根目录 .env 文件中（已 gitignore）。
> 复制 .env.example 并按需填入。
```
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=<DeepSeek API Key>
CHAT_MODEL=deepseek-v4-flash
EMBED_BASE_URL=https://open.bigmodel.cn/api/paas/v4
EMBED_API_KEY=<Zhipu API Key>
EMBED_MODEL=embedding-2
EMBED_DIMENSION=1024
```

## 运行测试
```bash
# 单元 + 集成 (无需 API)
npx vitest run --exclude='tests/memory/e2e/*'

# E2E 真实 API (需要 .env)
source .env && npx vitest run tests/memory/e2e/

# 全部
source .env && npx vitest run
```

## 设计文档
- **总索引**: `docs/README.md`（所有 Spec/Plan 清单 + 状态 + 快速导航，新功能实现前先查这里）
- Spec: `docs/superpowers/specs/`（每个已实现系统一份设计文档）
- Plan: `docs/superpowers/plans/`
- Web 契约: `docs/Web-API-Design.md`（新增/修改 core 方法必须对照）
- 备份: `E:\workSpace\ai-knowledge-base\alysiaAgent\`
