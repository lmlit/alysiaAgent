# alysiaAgent — Project Context

## What We're Building

AI Agent 桌面应用：聊天模式 + 编程模式，搭载"昔涟"人格和记忆系统。
- 聊天模式：Live2D 角色 + 对话，AI 自行调整人格
- 编程模式：类似 Claude Code，携带聊天模式积累的人格/记忆

## Current State

**记忆系统核心已完成 (28 源文件, 130 测试)**

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

## Next: Agent 主进程

待做:
1. Agent 核心循环 (函数调用循环 + AG-UI 事件流)
2. 聊天 UI (Electron + Live2D)
3. 工具系统 (文件操作/搜索/天气/文档生成等)
4. MCP 管理
5. 模式切换 (聊天 ↔ 编程)
6. Claude Code 集成 (全局 CLAUDE.md 注入记忆)

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
- Spec: `docs/superpowers/specs/2026-06-28-memory-system-design.md`
- Plan: `docs/superpowers/plans/2026-06-28-memory-system-plan.md`
- 备份: `E:\workSpace\ai-knowledge-base\alysiaAgent\`
