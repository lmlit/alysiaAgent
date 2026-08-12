---
status: active
source: docs/superpowers/specs/2026-06-28-memory-system-design.md
migrated: 2026-08-07
---
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
    facts       TEXT NOT NULL DEFAULT '[]',      -- [{fact, confidence, evidence, source_event,
                                                 --   updated_at, source, valid_from, valid_until, status}]
    updated_at  TEXT NOT NULL
);
```

单行记录，facts 带来源追溯、有效期限和状态标记。

**ProfileFact 字段**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `fact` | string | 事实内容 |
| `confidence` | 0.0-1.0 | 置信度 |
| `evidence` | string | 原文引用 |
| `source_event` | string | 来源事件 ID |
| `updated_at` | string | 更新时间 (ISO) |
| `source` | `'user'`\|`'behavior'`\|`'inferred'` | 来源: user=用户主动声明, behavior=行为推断, inferred=LLM 推断 |
| `valid_from` | string | 生效时间 (ISO) |
| `valid_until` | string\|null | 失效时间，null=永不过期 |
| `status` | `'active'`\|`'superseded'`\|`'expired'` | 状态: active=有效, superseded=被替代, expired=自然过期 |

**冲突解决规则**:
- 同 normalizeKey → 旧条 `status='superseded'`, `valid_until=now`（不删除，留审计链）
- 新条 `status='active'`, `valid_from=now` 插入
- `source='user'` 优先级最高，不会被 `inferred` 覆盖
- 新写入默认 `source='inferred'`, `confidence=0.4`, `status='active'`

### 2.3 Persona Store（AI 人格参数）— SQLite

```sql
CREATE TABLE persona (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    name            TEXT NOT NULL DEFAULT '昔涟',
    tone            TEXT NOT NULL DEFAULT '{}',      -- {formality, warmth, humor, directness}
    speech_style    TEXT NOT NULL DEFAULT '{}',      -- {sentence_length, emoji_usage, code_heavy}
    emotional_range TEXT NOT NULL DEFAULT '{}',      -- {expressiveness, empathy, playfulness}
    memory_config   TEXT NOT NULL DEFAULT '{}',      -- {retention_bias, decay_rate, importance_threshold,
                                                     --   recency_weight, confirmation_bias}
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
  → 去重与冲突检测 (新事实 vs 已有 facts, normalizeKey 索引)
  → LLM 提取事实 (带置信度和证据原文)
  → 合并入画像 (冲突时旧条 superseded + valid_until=now, 新条 active)
  → 定时画像摘要重写 (所有 active facts → ≤500 字自然语言摘要)
```

**冲突解决 (v2)**:
1. normalizeKey 匹配 → 视为同一事实的更新
2. 旧条 `status='superseded'`, `valid_until=now`（不删除，保留审计链）
3. 新条 `status='active'`, `valid_from=now` 插入
4. `source='user'` 的事实（用户主动声明）不会被 `inferred` 覆盖
5. 证据优先级: 用户纠正 > 行为模式 > 稳定模式 > 单次推断

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
memory_config: {
  retention_bias,        // 正负偏向: -1=只记坏的, +1=只记好的
  decay_rate,            // 遗忘速度: 0=不忘, 1=秒忘
  importance_threshold,  // 敏感度: 0=什么都记, 1=几乎不记
  recency_weight,        // 近期vs远期: 0=念旧, 1=只认最近
  confirmation_bias,     // 固执度: 0=随风倒, 1=从不改变看法
}
```

范围 [-1, +1]，初始值来自角色设定。

**记忆人格联动 (v2)**: 人格自适应引擎每次调整时，同步评估是否影响记忆行为，通过同一 PersonaAdapter 输出 `memory_config` 增量。LLM 根据交互模式判断角色是否"变得更念旧/更健忘/更记仇"，与 tone/speech/emotional 共用同一护栏机制。

**召回管道接线 (8-12，memory-knobs-into-recall-pipeline)**: `MemoryManager.read()`
排序前应用旋钮（`applyKnobsToRetrieved`，三路检索统一）：
- `decay_rate`：遗忘速度——半衰期 = 24h / decay_rate（0.3 → ~80h 半衰；1 → 24h；0 → 不忘）
- `recency_weight`：时间惩罚上限——`score × (1 − recency_weight × ageFactor × 0.5)`，
  `ageFactor = 1 − e^(−age/半衰期)`（0~1；=0 念旧不罚）
- `importance_threshold`：metadata.importance > threshold → score +0.15 优先
  （服务端 ingest importance 恒 0 期间不生效，importance 计算接入后自动生效）
- 知识库（无时间字段）天然不衰减；metadata 缺时间按最新处理
- 事件向量 metadata 已有 created_at；会话向量补 updated_at（存量向量无时间 → 不衰减）
- `retention_bias` / `confirmation_bias`：存储/提取情感偏向——未接线（作用面需
  importance/情感计算支持，后续）
- 对外：`MemoryManager.adjustMemoryConfig / getMemoryConfig`（Web 契约）

### 4.4 安全护栏

| 规则 | 作用 |
|---|---|
| 单次 Δ ≤ 0.1 | 渐变而非突变 |
| 同维度 5 分钟冷却 | 避免重复触发 |
| 连续同向 ≤ 3 次 | 防止滑坡到极端 |
| 24h 无信号回归 0.05 | 自然遗忘曲线 |
| 显式用户指令优先 | 立刻生效，不受限速 |

### 4.4.1 时效性分类与自动过期（8-12，profile-transient-expiry）

**问题（线上实锤）**：瞬时事件（"午餐吃了香菜拌牛肉"）被提成 confidence 1.0 的
active fact 永久固化（valid_until=null）→ `getUserActivitySummary` 按 confidence
取 top5 注入问候 prompt → bot 引用过期午餐（用户："香菜牛肉已经是我几百年前吃的午餐了"）。

**机制**：提取 prompt 要求 LLM 对每条事实输出 `transient` 分类：
- **稳定属性**（城市/职业/习惯/偏好/关系/身体状况/长期爱好）→ `transient=false`，
  `valid_until=null`（永久）
- **时效信息**（某天饮食/当天状态/单次事件/梦境/近期近况）→ `transient=true`，
  `valid_until = now + 48h`（自动过期，`getActiveFacts` 已过滤）

存量清洗（2026-08-12）：LLM 分批分类线上 194 条 facts，50 条时效事实补 48h
过期（备份 `alysia.db.cleanup-bak-*` 可回滚）；少量误判（体重/习惯）48h 后自然
消失，用户重提时重新提取。

### 4.5 纠正快路径 (v2)

**问题**: 用户纠正（"不是/记错了/改了"）要等 SessionEnd 才生效，期间系统还在用错误画像。

**解决**: 双路径设计：
- **慢路径**（SessionEnd）: LLM 批量提取 facts → mergeFacts → 逐条冲突解决
- **快路径**（Realtime）: 检测到纠正信号 → 立即旧条 superseded → 新条 source=user, confidence=1.0 插入

**纠正信号检测** (`detectCorrectionSignal`):
- 关键词: "不是"、"记错了"、"改了"、"不对"、"纠正一下"
- LLM 辅助: 小 prompt 定位被纠正的事实 + 提取新事实内容
- 证据优先级: 用户纠正 > 行为模式 > 稳定模式 > 单次推断

### 4.6 隐私模式 (v2)

**问题**: 临时话题/借用设备时，记忆照写照读，无控制开关。

**解决**: MemoryManager 暴露 `setPrivacyMode(mode)`:

| 模式 | 写入 EventLog | 读取 Profile/Worldbook | 使用场景 |
|------|:---:|:---:|------|
| `'off'` | ✅ | ✅ | 正常模式（默认） |
| `'readonly'` | ✅ | ❌ | 本次对话不被长期记忆引用 |
| `'full'` | ❌ | ❌ | 临时隐身/借用设备 |

会话结束后自动恢复 `'off'`。

触发方式:
- 用户消息: `//privacy full`、`//privacy readonly`、`//privacy off`
- Pipeline 阶段: 检测到隐私指令 → 调用 `memoryManager.setPrivacyMode()`

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

### 5.4 注入时机与过滤

- 会话启动: 读取持久化数据 → 生成初始 system prompt
- 每条用户消息: Worldbook 重新匹配
- 每 N 轮或用户主动: 重新向量检索刷新上下文

**召回过滤 (v2)**: 向量只找候选，状态决定用不用。
1. 只注入 `status='active'` 且 `valid_until` 未过期的事实
2. 按 `confidence` 降序，同 normalizeKey 只保留 active 的那条
3. `source='inferred'` 的事实前加 `(待确认)` 前缀
4. `source='user'` 的事实标注来源为「你告诉我的」
5. 隐私模式 `readonly`/`full` 时跳过 Profile/Worldbook 注入

---

### 5.3 Prompt 上下文修复（2026-08-09，change: prompt-context-fixes）

8-09 全量输入日志抓包（`[LLM] request`）发现并修复 4 缺陷：

1. **人格参数空值兜底**：persona 表 tone/speech_style/emotional_range 历史遗留 `{}`
   （ensureRow 只 INSERT OR IGNORE 不修已有行）→ PromptAssembler 输出 `undefined`。
   修复：PromptAssembler 空对象/缺失字段 fallback 默认参数；PersonaStore.ensureRow
   对已有空值行自动补默认 JSON（`{"formality":0,"warmth":0.2,...}`）
2. **画像事实去重增强**：入库层（ProfileStore.normalizeKey + addFact/addFacts 冲突检测）
   与组装层（PromptAssembler）统一"归一化 + 子串包含合并"——停用字扩表
   （的得了吗呢是个了在于是和也呀啊哦吧）、去"用户/你"主语前缀、去标点；
   包含判定：长侧 ≥5 字且短侧 ≥2 字（"长沙" ⊆ "目前所在城市长沙" 合并；
   "铁道" ⊆ "星穹铁道" 不误合并）
3. **会话摘要隔离**：ConversationStore.getRecent(limit, sessionId?)——private 会话只取
   private 摘要、group 只取同群；PromptAssembler/MemoryManager.assembleWithWorldbook/
   MemoryRetrievalStage 透传 sessionId（防群聊 summary 混入私聊 prompt）
4. **EventLog 读取契约**：getRecentBySession 的 content **不再拼 `${sender_name}: ` 前缀**
   （openid/默认"用户"不再泄露 prompt；Life assistant 回写不再显示"用户:"）；
   role 用显式 `payload.role`（memory-ingest 已写），旧数据 `sender_id` 推断兜底；
   senderName 独立字段。下游 memory-retrieval 组装 `[时间] 你/昔涟: 内容` 短角色标签

### 5.4 记忆完整性三件套（2026-08-09，change: memory-completeness-triple）

修 24h 记忆黑洞（短对话永不归档 + 对话回复不入库 + 事件向量死数据）：

1. **Bot 输出回写**（llm-agent POST 段）：assistant 最终回复 ingest 进 EventLog
   （role=assistant, source=chat, importance=0.3）——[最近对话] 输入输出成对，
   bot 记得自己说过什么
2. **定期归档**（cron 每 6h 调 MemoryManager.archiveStaleSessions）：24h 内有消息的
   活跃 session → SessionEndProcessor.process(sessionId, since?) 摘要归档；
   since = 该 session 最新摘要 ended_at（ConversationStore.getLatestBySession），
   防重复摘要；摘要输入含 assistant（[用户]/[昔涟] 角色标记）
3. **事件向量检索**（EventStore.searchByVector + read() 纳入查询，source='chat'）：
   [相关记忆] 可捞回超 24h 的对话细节（含回写后的 AI 发言）

EventStore 新增 getActiveSessions(since)；构造签名加 vectorStore 参数。

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
| 2026-07-29 | v2 画像系统: ProfileFact 加 source/valid_from/valid_until/status 四字段; 冲突解决改为 supersede+审计链; 召回加状态过滤和置信度排序; 新增纠正快路径 (RealtimeProcessor); 新增隐私模式 (full/readonly/off); 新增记忆人格旋钮 (memory_config) 与 PersonaAdapter 联动 |
