# alysiaAgent — Project Context

## What We're Building

AI Agent 桌面应用：聊天模式 + 编程模式，搭载"昔涟"人格和记忆系统。
- 聊天模式：Live2D 角色 + 对话，AI 自行调整人格
- 编程模式：类似 Claude Code，携带聊天模式积累的人格/记忆

## ★ 开发流程：OpenSpec（必读，最高优先）

项目管理采用 **OpenSpec 治理体系**（2026-08-07 起，取代 superpowers 时间点 spec）：

1. **每个行为变更（新功能/改行为/修 bug）必走 OpenSpec loop**：`propose → apply → archive`
   - propose：`/openspec-change <name>` 建 `openspec/changes/<name>/` 骨架（proposal.md + tasks.md + spec.md）
   - apply：实现代码 + 把变更合并回 `openspec/specs/<slug>/spec.md`
   - archive：`/openspec-archive` 归档到 `openspec/archive/` + 更新索引
   - **禁止"直改不 archive"**——写代码前先开 change，spec 是 source of truth
2. **对账方向规则**（spec 与实现不一致时先判方向）：
   - impl 对、doc 旧 → **改 doc**（ratify drift）
   - doc 已声明、impl 没接 → **改 impl，不改 doc**（把 spec 降级迁就现状 = 抹掉设计意图）
3. 纯文档修改也走 change（tasks.md 标"纯文档"）
4. 完整规则见 `openspec/project.md`（治理宪法）

## ★ 开发约束：Web 端接口兼容（必读）

后续开发**服务端功能**时，新增/修改 core 方法必须先对照 `docs/Web-API-Design.md`：

1. Web 端需要的功能（会话/画像/人格/Token/知识库/平台状态）必须在 **MemoryManager 或 AlysiaCore 暴露公开方法**，不在 pipeline/adapter 内部闭包
2. 方法返回**纯数据**（JSON 可序列化），不返回 DB 句柄/类实例
3. 命名：`get*Snapshot()` 只读 / `list*()` 列表 / `extract*()` LLM 提取 / `adjust*()` 带护栏调整 / `import*()` 导入
4. 新增方法要同步更新 `docs/Web-API-Design.md` 第 2/3 节状态标记

**目的**：避免 Web 端开发时回来改服务端接口、重复回归测试。

## Current State

**记忆系统核心 + 架构重构 + Feature Flag + AI 主动生活系统全部完成（187+ 测试通过）**

### Tech Stack
- TypeScript + better-sqlite3 (WAL) + LanceDB (嵌入式向量库)
- 测试: Vitest，单元/集成 + E2E (真实 API) + Cron

### API 配置 (.env, 已 gitignore)
- Chat/LLM: DeepSeek deepseek-v4-flash
- Embedding: 智谱 embedding-2 (1024 维)
- Vision: 智谱 GLM-4V-Flash（免费，VisionBridge 图片描述）
- 架构支持双 provider，Chat Base URL / Embed Base URL 分离，OpenAI 协议兼容

### 新增：AlysiaFeatures 能力开关
- `codeMode` / `shell` / `filesystem` / `streaming` flags
- 服务端: `features: { codeMode: false }` — 仅聊天工具
- 桌面端: `features: { codeMode: true }` — 全量工具 + CodeContextStore
- `MessageEvent.pipelineMode` — 'chat'|'code' 控制 Prompt 组装模式

### 文件结构（core）
```
src/memory/
├── types.ts                    # 所有类型 + 位掩码常量
├── database.ts                 # 表 schema + 默认行种子
├── MemoryManager.ts            # 统一入口 (ingest/read/assemble/onSessionEnd/cron + 8 个生活方法)
├── PromptAssembler.ts          # 双模式 System Prompt (chat ≤3200, code ≤2450 tokens)
├── PIIFilter.ts / TokenBudget.ts
├── interfaces/                 # IVectorStore / IEmbedService / ILLMService
├── services/                   # ★ OpenAI 协议通用服务（双 provider）
├── stores/                     # 8 个 Store（Event/Profile/Persona/Conversation/Knowledge/
│                               #   Worldbook/CodeContext/LifeStore + LanceDBStore 向量实现）
├── engines/                    # 3 个智能引擎（ProfileExtractor/PersonaAdapter 5 道护栏/WorldbookMatcher）
└── processors/                 # 3 个时间维度（Realtime/SessionEnd/Cron）
```

### 服务端（server）主要模块
- `bootstrap.ts` — 接线总装（核心/Pipeline/适配器/Proactive/Life/Reminder 推送/WebUI）
- `life.ts` — LifeService（AI 主动生活：事件生成/亲密度/每日摘要/剧情链）
- `proactive.ts` — ProactiveService（时段问候/节日节气/关怀，stateFile 去重）
- `adapters/qq-official.ts` — QQ 官方 Agent（WebSocket/图片识别/表情包/主动消息）
- `webui/server.ts` — Fastify 路由层（routes exercise all core methods）

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
- 记忆旋钮 memory_config：decay_rate/importance_threshold/recency_weight/confirmation_bias/retention_bias（亲密度已接线，召回管道待接 → backlog）

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
- 项目 skills: `.claude/skills/`（openspec-change / openspec-archive）

## Next（待做）

1. Web 端 UI（Fastify + Vue SPA，契约已就绪 docs/Web-API-Design.md）
2. Reminder 持久化到 SQLite（容器重启不丢失）
3. 流式输出 Pipeline 接入 (LLMAgentStage → textChatStream)
4. 桌面端 (Electron + Live2D, features.codeMode=true)
5. Backlog changes（见 openspec/specs/index.md 📌 Backlog）：worldbook 采样 cooldown、/api/platforms、记忆旋钮进召回管道
6. ai-life 二期：主提示词瘦身 / 窗口外事件补叙 / 事件向量检索 / worldbook life_event 种子 / 亲密度 Web UI

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
- **治理宪法（必读）**: `openspec/project.md` — OpenSpec 流程与对账规则
- **Spec 索引**: `openspec/specs/index.md`（19 个子系统，新功能实现前先查这里）
- **Backlog**: `openspec/specs/index.md` 📌 Backlog 节（doc 声明 impl 未接的登记）
- **总索引**: `docs/README.md`（所有文档入口）
- Web 契约: `docs/Web-API-Design.md`（新增/修改 core 方法必须对照）
- 部署 SOP: `docs/Docker-Deployment.md`（版本更新流程）
- 历史归档: `openspec/archive/`（已完成 change + legacy 迁移文档）
- 备份: `E:\workSpace\ai-knowledge-base\alysiaAgent\`
