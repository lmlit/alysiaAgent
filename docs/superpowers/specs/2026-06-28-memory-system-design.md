# 记忆系统设计文档

> 日期: 2026-06-28
> 状态: 已确认
> 项目: alysiaAgent

---

## 1. 系统总览与边界

### 1.1 定位

记忆系统是 Agent 主进程的核心子模块，位于模型调用层和 UI 层之间，通过 MemoryManager 对外暴露统一接口。

### 1.2 系统边界

| 范围内 | 范围外 |
|---|---|
| Event Log — 不可变事件流 | 模型调用、工具执行（已有模块） |
| Profile Store — 用户画像 CRUD + 自动更新 | Live2D 渲染 |
| Persona Store — AI 人格参数自适应 | 聊天 UI 组件 |
| Conversation Store — 对话摘要 + 向量检索 | MCP / 技能系统 |
| Knowledge Store — 外部知识 RAG | 嵌入模型 API 封装（已有模块） |
| Worldbook Store — 情境触发记忆注入 | Electron 打包 |
| Code Context Store — 项目上下文 | |
| MemoryManager — 统一调度、写入策略、检索路由 | |
| 存储抽象层 — 预留远端向量库接口 | |

### 1.3 技术选型

| 组件 | 技术 | 理由 |
|---|---|---|
| 主存储 | better-sqlite3 | 同步、零配置、Electron 原生兼容 |
| 本地向量库 | LanceDB | 嵌入式、支持增量写入、预留远端模式 |
| 嵌入模型 | OpenAI text-embedding-3-small | 远程 API（方案 B） |
| 向量维度 | 1536 | 与 text-embedding-3-small 一致 |
| 事件格式 | JSON 列 (SQLite) | 灵活 schema，可直接查询 |
| API Key 管理 | 本地明文 + .gitignore | 不上传至 Git |

### 1.4 架构

方案 C（Multi-Store Hybrid）为主 + 方案 A（Event Sourcing）为底座：
- Event Log 作为唯一写入源，所有输入先落成不可变事件
- 六种记忆类型各选最佳存储引擎
- MemoryManager 统一调度实时/批量/定时处理
- 存储抽象层实现 IVectorStore 接口，切换远端仅改一行注入

---

## 2. 数据模型

### 2.1 Event Log（不可变事件流）— SQLite

```sql
CREATE TABLE events (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    source      TEXT NOT NULL,             -- 'chat' | 'tool' | 'system' | 'code'
    type        TEXT NOT NULL,             -- 'message' | 'tool_call' | 'tool_result'
                                           -- | 'persona_change' | 'profile_hint' | 'session_summary'
    payload     TEXT NOT NULL,             -- JSON
    importance  REAL DEFAULT 0.0,
    created_at  TEXT NOT NULL,             -- ISO 8601
    processed   INTEGER DEFAULT 0          -- 位掩码: 1=画像, 2=摘要, 4=人格, 8=知识
);

CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_events_unprocessed ON events(processed, created_at);
```

### 2.2 Profile Store（用户画像）— SQLite

```sql
CREATE TABLE user_profile (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    basics      TEXT NOT NULL DEFAULT '{}',      -- JSON
    preferences TEXT NOT NULL DEFAULT '{}',      -- JSON
    facts       TEXT NOT NULL DEFAULT '[]',      -- [{fact, confidence, source_event, updated_at}]
    updated_at  TEXT NOT NULL
);
```

单行记录，facts 带来源追溯。

### 2.3 Persona Store（AI 人格参数）— SQLite

```sql
CREATE TABLE persona (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    name            TEXT NOT NULL DEFAULT '昔涟',
    tone            TEXT NOT NULL DEFAULT '{}',      -- {formality, warmth, humor, directness}
    speech_style    TEXT NOT NULL DEFAULT '{}',      -- {sentence_length, emoji_usage, code_heavy}
    emotional_range TEXT NOT NULL DEFAULT '{}',      -- {expressiveness, empathy, playfulness}
    adaptation_hints TEXT NOT NULL DEFAULT '[]',    -- [{trigger, adjustment, evidence, applied_at}]
    updated_at      TEXT NOT NULL
);
```

### 2.4 Conversation Store（对话摘要 + 向量）— SQLite + LanceDB

SQLite:
```sql
CREATE TABLE conversations (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    summary         TEXT NOT NULL,
    participants    TEXT NOT NULL DEFAULT '[]',
    topics          TEXT NOT NULL DEFAULT '[]',
    key_decisions   TEXT NOT NULL DEFAULT '[]',
    message_count   INTEGER DEFAULT 0,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    embedding_id    TEXT
);
```

LanceDB: `conversation_vectors (id, vector[1536], text, metadata)`

### 2.5 Knowledge Store（外部知识 RAG）— SQLite + LanceDB

SQLite:
```sql
CREATE TABLE knowledge_docs (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    source          TEXT NOT NULL,         -- 'imported' | 'url' | 'note' | 'generated'
    file_path       TEXT,
    content_hash    TEXT NOT NULL,         -- SHA256 去重
    chunk_count     INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'active',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

LanceDB: `knowledge_chunks (id, doc_id, vector[1536], text, chunk_index, metadata)`

### 2.6 Worldbook Store（情境触发）— Key-Value + 向量

```sql
CREATE TABLE worldbook_entries (
    id              TEXT PRIMARY KEY,
    trigger_keys    TEXT NOT NULL,          -- JSON: ["rust", "生命周期", "ownership"]
    trigger_mode    TEXT DEFAULT 'any',     -- 'any' | 'all' | 'regex'
    content         TEXT NOT NULL,
    scope           TEXT DEFAULT 'chat',    -- 'chat' | 'code' | 'both'
    priority        INTEGER DEFAULT 0,
    cooldown_sec    INTEGER DEFAULT 300,
    last_triggered  TEXT,
    hit_count       INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

### 2.7 Code Context Store（项目上下文）— SQLite

```sql
CREATE TABLE code_context (
    id              TEXT PRIMARY KEY,
    project_name    TEXT NOT NULL,
    project_path    TEXT NOT NULL,
    tech_stack      TEXT NOT NULL DEFAULT '{}',
    architecture_notes TEXT DEFAULT '',
    recent_changes  TEXT DEFAULT '[]',
    decisions       TEXT DEFAULT '[]',      -- [{decision, reason, date}]
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

---

## 3. MemoryManager 调度流程

### 3.1 三层处理时机

| 实时（每条消息后） | 会话结束时 | 定时（凌晨 3 点） |
|---|---|---|
| Worldbook 匹配 | 对话摘要生成 | 旧事件压缩 |
| 人格微调提示 | 重要性评分批量更新 | 向量去重清理 |
| 轻量画像提示 | 画像整合更新 | 深度画像重算 |
| 嵌入向量生成（异步） | Worldbook 规则优化 | 知识库过期清理 |

### 3.2 写入流程

```
外部输入 → Event Log（不可变，立刻落盘）
  → 实时处理器: Worldbook 匹配 + 人格扫描 + 嵌入生成（异步）
  → 会话关闭: LLM 摘要 + 画像聚合 + 人格确认
  → 定时任务: 压缩 + 去重 + 深度画像 + 清理
```

### 3.3 检索流程

```
query → Worldbook 先匹配 → query → embed API → 向量
  → LanceDB 向量检索 (conversation_vectors + knowledge_chunks)
  → SQLite 结构化查询 (profile + persona + code_context)
  → 融合排序 (向量距离 × 0.5 + 时间衰减 × 0.3 + 重要性 × 0.2)
  → 组装返回
```

### 3.4 存储抽象层接口

```typescript
interface IVectorStore {
  insert(id: string, vector: number[], text: string, metadata: object): Promise<void>;
  search(vector: number[], topK: number, filter?: object): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}
```

本地: LanceDBStore，未来: QdrantStore / PineconeStore。

---

## 4. 自动画像更新 & 人格自适应引擎

### 4.1 画像更新流水线

```
候选筛选 (importance > 0.4, 未处理画像标记)
  → 去重与冲突检测 (新事实 vs 已有 facts)
  → LLM 提取事实 (带置信度和证据原文)
  → 合并入画像 (冲突时高置信度替换低)
  → 定时画像摘要重写 (所有 facts → ≤500 字自然语言摘要)
```

### 4.2 人格自适应引擎

触发源:
- 用户直接反馈（"你太啰嗦了"）
- 行为隐式信号（反复打断、话题频繁跳转）
- 对话模式变化（技术讨论 → 闲聊）

处理流程:
```
信号分类（显式/隐式） → LLM 调整决策 → 限速与衰减 → 生效
```

### 4.3 人格参数维度

```
tone: {formality, warmth, humor, directness}
speech_style: {avg_sentence_length, emoji_usage, code_heavy}
emotional_range: {expressiveness, empathy, playfulness}
```

范围 [-1, +1]，初始值来自角色设定。

### 4.4 安全护栏

| 规则 | 作用 |
|---|---|
| 单次 Δ ≤ 0.1 | 渐变而非突变 |
| 同维度 5 分钟冷却 | 避免重复触发 |
| 连续同向 ≤ 3 次 | 防止滑坡到极端 |
| 24h 无信号回归 0.05 | 自然遗忘曲线 |
| 显式用户指令优先 | 立刻生效，不受限速 |

---

## 5. System Prompt 注入

### 5.1 两种模式对比

| 维度 | 聊天模式 | 编程模式 |
|---|---|---|
| 角色设定 | 完整人格（所有维度） | 精简人格（仅 formality + directness） |
| 用户画像 | 完整注入 | 精简注入（仅技术相关字段，约 150 tokens） |
| 对话记忆 | 最近 3 条摘要 + 向量检索 | 不注入 |
| 知识库 | top-3 | top-5 |
| Worldbook | scope=chat/both | scope=code/both |
| 项目上下文 | 不注入 | 项目名 + 技术栈 + 架构 + 技术决策 |
| Token 上限 | ≤3200 | ≤2450 |

### 5.2 编程模式精简画像

编程模式从 user_profile 中筛选技术相关字段注入，控制在 ~150 tokens：

```
[编程模式用户画像]
- 角色：{basics.occupation}，{basics.experience}
- 技术栈偏好：{preferences.code_languages}
- 代码风格：{preferences.code_style}
- 注释习惯：{preferences.comment_style}
- 当前学习/关注：{从 facts 中筛选技术相关条目}
```

筛选规则：
- 保留：「职业」「技术水平」「代码偏好」「技术栈」「工作习惯」「时区」
- 丢弃：「兴趣爱好」「生活琐事」「非技术偏好」「家庭/朋友信息」

**理由**：同一个技术问题对不同背景的人回答方式完全不同。后端工程师 vs 设计师、Rust 新手 vs 5 年老手，代码解释深度和类比方式应有区别。

### 5.3 模式切换传递

聊天 → 编程: 压缩人格 + 精简画像 + 编码偏好 + Worldbook(both)，不传对话摘要。
编程 → 聊天: 完整恢复人格 + 完整恢复画像 + 写入一次编程摘要 + 更新编码偏好。

### 5.4 注入时机

- 会话启动: 读取持久化数据 → 生成初始 system prompt
- 每条用户消息: Worldbook 重新匹配
- 每 N 轮或用户主动: 重新向量检索刷新上下文

---

## 6. 完整数据流

### 读路径

```
query → Worldbook 匹配 → embed API → LanceDB 向量检索
  → SQLite 结构化查询 → 融合排序 → 按模式选模板 → system prompt
```

### 写路径

```
输入 event → events 表 INSERT
  → 实时处理器: Worldbook + 人格扫描 + 嵌入生成
  → 会话关闭: 摘要 + 画像 + 人格确认 + Worldbook 优化
  → 定时任务: 压缩 + 去重 + 深度画像 + 清理
```

---

## 7. 错误处理 & 边缘情况

| 场景 | 处理策略 |
|---|---|
| Embed API 挂了 | 向量检索降级为 SQLite LIKE，写入进重试队列，指数退避 |
| LLM 提取失败 | 非实时，失败跳过，下次 cron 补处理 |
| LanceDB 损坏 | 启动 checksum 校验，异常则提示从 events 重建 |
| 磁盘空间不足 | events > 500MB 自动压缩，chunk > 10000 告警 + LRU |
| 并发写入 | SQLite WAL 模式，单写串行，读并发无锁 |
| 嵌入维度不一致 | 启动检查，不匹配重建表 |
| 敏感信息 | PII 脱敏扫描（手机号/身份证/银行卡），写入和嵌入前双重检查 |

---

## 8. 测试策略

### 测试金字塔

- **单元测试 (30+)**: 每个 Store 独立 CRUD、事件处理器、Worldbook 匹配、人格限速、token 裁剪
- **集成测试 (8+)**: ingest → 检索全路径、会话关闭 → 摘要、模式切换传递
- **E2E 测试 (2+)**: 完整会话 → 画像变化 → 人格调整，mock LLM/Embed API
- **合约测试**: IStorage / IVectorStore 接口所有实现类跑同一套测试

工具: vitest，LanceDB 用临时目录，mock 外部 API。

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-06-28 | 初始设计，确认所有 7 节内容 |
| 2026-06-28 | 修正：编程模式改为注入精简画像（仅技术相关字段） |
