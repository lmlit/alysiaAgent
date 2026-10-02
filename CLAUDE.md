# alysiaAgent — Project Context

## What We're Building

AI Agent 桌面应用：聊天模式 + 编程模式，搭载"昔涟"人格和记忆系统。
- 聊天模式：Live2D 角色 + 对话，AI 自行调整人格
- 编程模式：类似 Claude Code，携带聊天模式积累的人格/记忆
  - ★ 2026-10-02：**由 DeepSeek Harness（dsh）承接**（自建 Electron 壳 9-25 已砍）。
    集成代码在 `packages/dsh-adapter`；定位与通道见 `openspec/specs/dsh-adapter/spec.md`。

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

**记忆系统核心 + 架构重构 + Feature Flag + AI 主动生活系统 + 模块化内核 + dsh 通道全部完成。**
测试基线：**965**（常规，含 `dsh-adapter` / `dsh-console`）+ **E2E 5/5**（真实 API）。
★ 2026-10-02 起**编程模式由 dsh 承接，四层通道（人格 / 记忆读 / 记忆写 / 结算）全通**。

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
src/
├── kernel/                     # ★ 2026-10-01：模块装载内核（Module 契约 + ModuleHost，cordis 形状）
├── modules/                    # ★ 2026-10-01：13 个装配模块（db/vector/embed/memory-llm/provider/
│                               #   eventbus/memory/coalescer/persona-seed/tools/commands/pipeline/boot）
├── options.ts                  # ★ 2026-10-01：构造选项（从 index.ts 抽出，解 modules/ 循环依赖）
├── index.ts                    # AlysiaCore 统一入口（公开面逐字不变）
└── memory/
├── types.ts                    # 所有类型 + 位掩码常量
├── database.ts                 # 表 schema + 默认行种子
├── MemoryManager.ts            # 统一入口 (ingest/read/assemble/onSessionEnd/cron + 8 个生活方法)
├── PromptAssembler.ts          # 双模式 System Prompt (chat ≤3200, code ≤2450 tokens)
├── PIIFilter.ts / TokenBudget.ts
├── interfaces/                 # IVectorStore / IEmbedService / ILLMService
├── services/                   # ★ OpenAI 协议通用服务（双 provider；⚠️ 仅测试在用的半死代码，见 KI-9）
├── stores/                     # 8 个 Store（Event/Profile/Persona/Conversation/Knowledge/
│                               #   Worldbook/CodeContext/LifeStore + LanceDBStore 向量实现）
├── engines/                    # 3 个智能引擎（ProfileExtractor/PersonaAdapter 5 道护栏/WorldbookMatcher）
└── processors/                 # 3 个时间维度（Realtime/SessionEnd/Cron）
```

### 服务端（server）主要模块
- `bootstrap.ts` — ★ 2026-10-01（P3）起**只做装配**（建宿主 + 注册 10 个模块 + 跑）
- `modules/` — 10 个装配模块（config/logging/core/vision/adapters/proactive/life/reminder/cron/webui）
- `push.ts` — `PushChannel` 接口（life/proactive 只用 `sendProactive`，不耦合具体适配器）
- `prompts/` — life 提示词资产（**有意不做 `.md`**，判据见其 README）
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
- Clash 代理: **127.0.0.1:7897**（★ 2026-10-02 更正：原写 7890，实测该端口已失效；
  以 `netstat \| grep LISTENING` 实测为准），推送前需开启
- Skill: `/clash-proxy` 或直接:
  ```bash
  git config --global http.proxy http://127.0.0.1:7897
  git config --global https.proxy http://127.0.0.1:7897
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

> ★ 2026-10-02 重写：原列表**已全部过期**（Web UI 已上线 / Reminder 已持久化 /
> 流式已接 / Electron 壳已砍）。**真正的待做以 `openspec/specs/index.md` 的 📌 Backlog
> 与 `docs/KNOWN-ISSUES.md` 为准**，本节只留指针，不再重复维护。

1. **调召回系数** `tune-recall-with-runtime-data` —— 阻塞已解除（摘要修好 + 存量回填干净），
   但**先积累运行数据再调**，别拍脑袋改系数（部分指标现在还没日志）
2. **两个老 backlog**：`add-platforms-endpoint`（契约声明了但全仓没建）、
   `worldbook-sampling-cooldown`（世界书采样缺 cooldown 过滤）
3. **可观测性** `add-ops-health-report` —— 存活指标骗过一次（22 天全绿）；
   前置是日志降噪（96.6% 是 QQ 噪声）
4. **文档卫生** `clean-spec-diff-residue` —— apply 残留的 `+ ` diff 标记。
   ★ 2026-10-02 实测范围比立项时记的大（`ai-life-system` 约 42 行，不止 `memory-system` 那 5 行）；
   ⚠️ **不能直接 `grep '^+'` 删**，里面混着 ASCII 树角字符和提示词模板正文
5. **console 收尾**：表情包 `[表情包:名字]` 渲染（现按纯文本）、`play_live2d_action` 工具 +
   输出驱动状态切换、**删 `packages/webui`**（三约束已解除，但**不是纯删**：
   `server.ts` 的 `defaultDist`、`bootstrap.ts` 的 `IS_DESKTOP` 分支）
6. **隐患**（`docs/KNOWN-ISSUES.md`）：KI-1 `life.generateEvent` 槽**没有 `max_tokens`**
   —— 与已爆三次（会话摘要 22 天 / 每日反思 11 次 / 画像提取 6 个月）的槽**同形**。
   ★ **2026-10-02 起观测手段已就绪**（`add-llm-budget-observability`）：
   provider 的 `[LLM]` 行与 `[Life] event LLM` 行会打出 `finish=` / `reasoning=` / `content=N字`。
   **下一步是采数据再决策**（`finish=length` + 空内容 ⇒ 加 `max_tokens`），
   **不要再凭感觉填数字**
7. **dsh 侧** `build-alysia-console-plugin` **进行中且上游已变**——原方案踩在已废弃的
   `.agent-presets` / `tapIndex` 上（dsh 桌面端换代了插件机制），需重新判断范围

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
- **Spec 索引**: `openspec/specs/index.md`（21 个子系统，新功能实现前先查这里）
- **Backlog**: `openspec/specs/index.md` 📌 Backlog 节（doc 声明 impl 未接的登记）
- **总索引**: `docs/README.md`（所有文档入口）
- Web 契约: `docs/Web-API-Design.md`（新增/修改 core 方法必须对照）
- 部署 SOP: `docs/Docker-Deployment.md`（版本更新流程）
- 历史归档: `openspec/archive/`（已完成 change + legacy 迁移文档）
- 备份: `E:\workSpace\ai-knowledge-base\alysiaAgent\`
