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

## ★ 部署是流程的一部分，不是可选项（2026-10-25 立）

**每一批 change 做完就部署，不要攒**。这条是踩出来的：
2026-10-24～25 有 8 个 change 只提交不部署，结果「验收」变成了让用户去重启一个根本没更新的服务 ——
而 SOP（`docs/Docker-Deployment.md`）的顺序本来就是 **Step 3 部署 → Step 5 提交**，是我做反了。

### ★★ 顺序是「本地真机 → 生产」，**不许反过来**（2026-10-25 追加，用户明确要求）

用户原话：「**直接推生产，本地改完本地真机测一下调用 api 测，测完没问题再推服务器好不好**」

我这一整天把生产当测试环境（同一天直推 8 次）。现在这条**做成了机器闸**，不靠记性：

```bash
pnpm smoke            # 本地起真服务 + 调真 API（deploy 会自动先跑这个）
pnpm chat             # ★ 本地**真的跟她聊几轮**，把她的原话打出来（改说话相关时必跑）
pnpm chat -- --fresh --turns 4   # 清库重来 / 改轮数
ALYSIA_DEPLOY_HOST=root@<host> pnpm deploy:dry   # 空跑：前置检查 + smoke + config 漂移
ALYSIA_DEPLOY_HOST=root@<host> pnpm deploy       # 真部署（内部**强制**先跑 smoke，不过不许推）
```

- `scripts/chat-local.mjs`（用户要求：「本地验证直接对话一波，本地的数据调用真机不会被污染」）：
  起本地真服务（端口 6188、数据目录 `.tmp/chat-local/`、**删 `platforms` 不连 QQ**），
  用 `POST /api/chat/prompt` **同一 sessionId 多轮对话**，打出她的原话 + 指标
  （字数 / 语气词个数 / 有无问句 / 是否语气词起头）。失败时**自动 dump 服务端日志**。
- `scripts/smoke-local.mjs` 做什么：
  1. **先重建 dist** —— 否则测的是旧产物，比没闸更危险（给人假的安全感）
  2. 生成**临时配置**：**删掉整个 `platforms`**（⚠️ 同一 QQ AppID 两处在线会**互踢**，SOP 红线）、
     端口 6187、数据目录隔离到 `.tmp/smoke/`（不碰本地开发库）
  3. 起真服务 → 等 `/api/health` → **调 `POST /api/memory/read`**
  4. 断言组装结果**含**必须的块、**不含**被产品否决的措辞
  5. 杀进程；任一步失败 ⇒ 退出码非 0 ⇒ 部署中止
- 唯一例外 `--skip-smoke`：会**大声警告**（只该用于"生产已烧起来、必须紧急回滚"）

- **host 只在环境变量里**，绝不写进仓库（本仓 PUBLIC，已发生两次泄露事故）
- 脚本 `scripts/deploy.mjs` 拦的**四**个坑，都是**不报错**的那种：
  ① `config.yml` 是 **gitignore** 的、与服务器会漂移 —— 整份覆盖曾把服务器侧
  `max_tokens 1024→256` / `4096→2048` 和整段 `projects:`（委托工具靠它注册）静默退回默认
  ⇒ 脚本**默认拒绝**服务器独有键，要显式 `--merge-config`；
  ② 切镜像前不打回滚标签 ⇒ 退不回去；③ 切完不看健康 ⇒ 服务半死而你以为发成功了；
  ④ **回滚标签只打不删**（★ 2026-10-25 补）⇒ 实测生产 37 个镜像 / 8.736 GB、可用只剩 1 个，
  一天 12 次部署 ≈ 4.7 GB/天，而它爆掉时报的是**数据库写入失败**。
  ⇒ Step 6 部署成功后只留最近 3 个（`--keep-rollbacks=N` / `ALYSIA_ROLLBACK_KEEP`），
  决策在 `scripts/lib/rollback-retention.mjs`（纯函数 + 19 条单测，**`latest` 结构性不可删**、
  **按 docker `CreatedAt` 排序而非标签名**）。契约见 `openspec/specs/deploy-pipeline/spec.md`
- 部署完把 `docker ps` + `/api/health` 输出记进该 change 的 tasks，**那才是验收依据**

## ★ 开发约束：Web 端接口兼容（必读）

后续开发**服务端功能**时，新增/修改 core 方法必须先对照 `docs/Web-API-Design.md`：

1. Web 端需要的功能（会话/画像/人格/Token/知识库/平台状态）必须在 **MemoryManager 或 AlysiaCore 暴露公开方法**，不在 pipeline/adapter 内部闭包
2. 方法返回**纯数据**（JSON 可序列化），不返回 DB 句柄/类实例
3. 命名：`get*Snapshot()` 只读 / `list*()` 列表 / `extract*()` LLM 提取 / `adjust*()` 带护栏调整 / `import*()` 导入
4. 新增方法要同步更新 `docs/Web-API-Design.md` 第 2/3 节状态标记

**目的**：避免 Web 端开发时回来改服务端接口、重复回归测试。

## Current State

**记忆系统核心 + 架构重构 + Feature Flag + AI 主动生活系统 + 模块化内核 + dsh 通道全部完成。**
测试基线：**1992**（**171** 个测试文件，★ 2026-10-28 实测全绿；原写 1911 已过期，
分 package 的数字以 `docs/HANDOFF.md` 顶部为准 —— 本行只是快照）
+ **E2E 5/5**（真实 API）。⚠️ 跑测试**必须用 Node 24**（`E:\nodejs24\node.exe`），
PATH 上的 node 是 v20，而 better-sqlite3 是给 24 编的 —— 否则 401 条全挂（`NODE_MODULE_VERSION` 不匹配）。
★ 2026-10-02 起**编程模式由 dsh 承接**。⚠️ **2026-10-24 起只保留「读」**：
`alysia-adapter.config.bridge: false` 已切掉 `ingest` 与会话结算（写），
`recall_memory` 与 `{{alysia_persona}}` 人格注入保留。

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
- `MessageEvent.pipelineMode` — 'chat'|'code' 选组装表；⚠️ **生产链路没有写者**（恒 `'chat'`），
  `code` 仅单测 / `POST /api/memory/read {mode:'code'}` 可达（2026-10-26 标死，不接线）

### 文件结构（core）
```
src/
├── kernel/                     # ★ 2026-10-01：模块装载内核（Module 契约 + ModuleHost，cordis 形状）
├── modules/                    # ★ 2026-10-01：13 个装配模块（db/vector/embed/memory-llm/provider/
│                               #   eventbus/memory/coalescer/persona-seed/tools/commands/pipeline/boot）
├── options.ts                  # ★ 2026-10-01：构造选项（从 index.ts 抽出，解 modules/ 循环依赖）
├── index.ts                    # AlysiaCore 统一入口（公开面逐字不变）
└── memory/
├── types.ts                    # 所有类型（`processed` 位掩码已于 2026-10-26 删除）
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
  （★ 这里的 `webui` 是**模块名**（`al:webui`，托管 console 的那个），不是已删的 `packages/webui`）
- `push.ts` — `PushChannel` 接口（life/proactive 只用 `sendProactive`，不耦合具体适配器）
- `prompts/` — life 提示词资产（**有意不做 `.md`**，判据见其 README）
- `life.ts` — LifeService（AI 主动生活：事件生成/亲密度/每日摘要/剧情链）
- `proactive.ts` — ProactiveService（时段问候/节日节气/关怀，stateFile 去重）
- `adapters/qq-official.ts` — QQ 官方 Agent（WebSocket/图片识别/表情包/主动消息）
- `webui/server.ts` — Fastify 路由层（routes exercise all core methods）+ console 静态托管。
  ★ 与已删的 `packages/webui` **无关**（同名不同物）；★ 10-02 起 `webui:` 目录名保留、只托 console

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
- **★ 提交前敏感扫描（pre-commit hook，2026-10-03 立）**：本仓 **PUBLIC**，同类泄露事故
  已发生两次（8-09 `git add -A` 带进内部 SOP、8-28 密码明文进脚本暴露 28 天），两次都是人工审查漏的。
  安装（每 clone 一次，本地配置不随仓库走）：`git config core.hooksPath scripts/git-hooks`；
  详见 `scripts/git-hooks/README.md`。本地敏感词表在 `.git/alysia-secret-patterns`（不公开）。

### Skills 仓库
- `https://github.com/lmlit/my-claude-skills` (公开)
- 本地: `E:\workSpace\my-claude-skills\`
- 全局 skills: `~/.claude/skills/` (superpowers 14 个 + clash-proxy)
- 项目 skills: `.claude/skills/`（openspec-change / openspec-archive）

## Next（待做）

> ★ 2026-10-02 重写：原列表**已全部过期**（Web UI 已上线 / Reminder 已持久化 /
> 流式已接 / Electron 壳已砍）。★ **2026-10-18 起唯一在办入口是 `docs/TODO.md`**
> （逐条导航，指向 KI 登记册 / spec Backlog / changes 的权威正文）；本节只留指针。

1. **调召回系数** `tune-recall-with-runtime-data` —— 阻塞已解除（摘要修好 + 存量回填干净），
   但**先积累运行数据再调**，别拍脑袋改系数（部分指标现在还没日志）
2. ~~两个老 backlog：`add-platforms-endpoint`、`worldbook-sampling-cooldown`~~
   ✅ **2026-10-16 都已完成并归档**（平台状态端点口径收敛为"已接入的 scope"；
   世界书采样冷却取 `max(6h, 条目 cooldown_sec)`）
3. **可观测性** `add-ops-health-report` —— ✅ **2026-10-16 前置评估已完成**
   （`scripts/log-profile.cjs`：本机样本单一来源 QQ 占 84%、关键信号 `SessionEnd` 仅 0.2%
   ⇒ **按日志行数比例做监控必然无效**；且**前置（日志源头分级/限频）尚未完成**）。
   **2026-10-26 决定：不做**（要做先清日志源头分级/限频，见 `docs/TODO.md` C 段）。
4. ~~**文档卫生** `clean-spec-diff-residue`~~ ✅ **2026-10-16 已清理归档**：
   真值 **55 行**（不是 5 行、也不是 ~42 行），其中 15 行在代码块内
   （提示词模板 + ASCII 树 `+│`）。全部纯剥行首 `+`、内容零改动。
   防复发已做成**机器拦得住**：`scripts/check-spec-diff-residue.cjs`（残留即 exit 1）
   已接进 `.claude/skills/openspec-archive` 的 apply 步骤 —— **合并后必须跑，非 0 不许归档**
5. **console 收尾**：表情包 `[表情包:名字]` 渲染（现按纯文本，★ 10-02 起已无任何前端渲染它）、
   `play_live2d_action` 工具 + 输出驱动状态切换
   ~~**删 `packages/webui`**~~ ★ **2026-10-02 已完成**（`remove-packages-webui`，已归档）：
   包已删、`defaultDist` 回落移除（缺产物 → **显式 warn**，不再静默 404）、前端托管不再看 `isDesktop`。
   遗留：7 项管理能力降级为 API-only（清单见该 change 遗留表）
6. **隐患**（`docs/KNOWN-ISSUES.md`）：KI-1 `life.generateEvent` 槽**没有 `max_tokens`**
   —— 与已爆三次（会话摘要 22 天 / 每日反思 11 次 / 画像提取 6 个月）的槽**同形**。
   ★ **2026-10-02 起观测手段已就绪**（`add-llm-budget-observability`）：
   provider 的 `[LLM]` 行与 `[Life] event LLM` 行会打出 `finish=` / `reasoning=` / `content=N字`。
   **下一步是采数据再决策**（`finish=length` + 空内容 ⇒ 加 `max_tokens`），
   **不要再凭感觉填数字**
7. **dsh 侧** `build-alysia-console-plugin` **2026-10-26 冻结**（dsh 已降权；面板 1/2 在，剩 3 个面板不做了）。
   下面是 2026-10-16 的更正记录，保留以免下次重犯：
   不是"踩在已废弃的 `.agent-presets` / `tapIndex` 上"——
   `.agent-presets` 确实废弃（本包早已不用，走 `dsh.bundle.patch`），
   但 **`tapIndex` 没废弃**（dsh 文档称它是"逃生口"）；
   **真问题是桌面端 UI 不走 `renderIndex()` ⇒ `tapIndex` 在桌面端不执行**，
   入口脚本进不了页面。**已修**为 `webserver/index-inject` 行。
   **剩**：3 个面板页（世界书/生活模板、记忆旋钮、审计）+ `install_bundle` 真机验收。
   ⚠️ 装 bundle 前**必须先 `npm run build`**（`main` 指向 `dist/`，而 `dist/` 是 gitignored）

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
- **Spec 索引**: `openspec/specs/index.md`（**24** 个子系统，新功能实现前先查这里）
- **Backlog**: `openspec/specs/index.md` 📌 Backlog 节（doc 声明 impl 未接的登记）
- **总索引**: `docs/README.md`（所有文档入口 + A–H 分类 + 每篇 status/时效）
- **待办总表**: `docs/TODO.md`（唯一在办入口；不新建编号，沿用 KI-xx / change 名）
- **静默失败族**: `docs/SILENT-FAILURE.md`（根因与修复顺序；族内**4 条在办**：KI-1/2/11/25）
- Web 契约: `docs/Web-API-Design.md`（新增/修改 core 方法必须对照）
- 部署 SOP: `docs/Docker-Deployment.md`（版本更新流程）
- 历史归档: `openspec/archive/`（已完成 change + legacy 迁移文档）
- 备份: `E:\workSpace\ai-knowledge-base\alysiaAgent\`
