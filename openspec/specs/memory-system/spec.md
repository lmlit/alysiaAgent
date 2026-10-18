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
-- ★ 8-28 视角标记（memory-character-perspective）：'interaction'(与用户互动) | 'self'(昔涟自己的生活)
-- ALTER TABLE events ADD COLUMN perspective TEXT DEFAULT 'interaction';

CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_events_unprocessed ON events(processed, created_at);
```

**查询语义（★ 9-26 窗口修复 / 回填）**：`EventStore.getBySession(sessionId, { limit?, since?, until? })`
返回该会话**最近的** N 条事件（默认 1000），可按 `since` 过滤，**按时间升序**返回。
- `since` 过滤**下推到 SQL**。原实现是「`ORDER BY created_at ASC LIMIT 1000` 取最旧 1000 条、
  再在内存里 filter」——于是窗口内取不取得到取决于**窗口外有多老**：主会话事件数超 1000 后，
  `since` 之后的事件一条都取不到，归档管道静默空转，日志却报 `archived 1/1`。
- 语义是「最近 N 条」不是「最旧 N 条」；会话是"永不结束"的，取错一端等于长期摘要永久失效。
- `until`（★ 9-26 回填新增）：**时间窗上界**，供历史回填用。窗口是 `[since, until]`，
  **两端都必须下推 SQL** —— 只约束下界的话，长会话里 `until` 之后的近期事件会占满
  DESC LIMIT，把要回填的老窗口整个挤出去（与上面同源的坑）。

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
-- ★ 8-28 角色事实（memory-character-perspective）：昔涟自己的事（与 facts 用户事实并列，
--   同 ProfileFact 结构含分类/TTL/确认机制）——"她最近在学什么/讨厌什么/对某事的看法"
-- ALTER TABLE user_profile ADD COLUMN character_facts TEXT NOT NULL DEFAULT '[]';
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
| `category` | `'identity'`\|`'preference'`\|`'status'`\|`'relationship'`\|`'general'` | ★ 8-28 分类（profile-facts-classification-confirm）：决定过期时长 |

**冲突解决规则**:
- 同 normalizeKey → 旧条 `status='superseded'`, `valid_until=now`（不删除，留审计链）
- 新条 `status='active'`, `valid_from=now` 插入
- `source='user'` 优先级最高，不会被 `inferred` 覆盖
- 新写入默认 `source='inferred'`, `confidence=0.4`, `status='active'`

**★ 8-28 分类过期（profile-facts-classification-confirm）**：
- 分类过期时长：identity 365 天 / preference 90 天 / status 14 天 / relationship 90 天 / general 60 天；
  写入时按分类设 valid_until（显式传入 valid_until 优先）；存量 null 保持不过期（不强制迁移）
- 分类来源：ProfileExtractor 提取时 LLM 判断（prompt 加分类要求）
- **过期确认闭环**（对话中自然问，不推送）：
  - `listPendingConfirmFacts()`：valid_until 在过去 3 天内且 status='active' → 待确认
  - PromptAssembler 注入【待确认的事实】块（≤2 条，`- 事实 (M月d日记录的)`）——昔涟在合适时机自然询问
  - 工具 `confirm_profile_fact(fact_id, still_valid)`：确认 → 按分类重设 valid_until（续期一个周期）；
    否认 → superseded
  - 过期超 3 天未确认 → 自动 status='expired'（不反复打扰）

**★ 8-28 时间标注（profile-facts-timestamps）**：
- 数据层时间字段（valid_from/updated_at）已齐全，**展示层补上**：
- PromptAssembler 注入格式：`- 用户在长沙 [你说过] (3天前)`——相对时间（今天/昨天/N天前/超 30 天显示 `M月d日`），
  时间基准 = valid_from/updated_at 较新者（"用户正在玩绝区零" 8-01 提取、8-02 被替代更新 → 显示 8-02 更贴近当前认知）
- getProfileSnapshot 返回 facts 增量加 `updatedAt`/`validFrom`（Web 画像页展示时间列，不破坏现有字段）

**★ 8-28 角色事实（memory-character-perspective）**：
- `character_facts` 与 `facts` 并列，**结构完全复用 ProfileFact**（含 8-28 分类/TTL/过期确认机制）——
  用户事实 + 角色事实各一套，互不混淆
- 来源：ProfileExtractor 同一次 LLM 调用双输出（用户 facts + 角色 facts）；生活事件回写
  （ingest perspective='self'）走同一提取器 → **生活累积自动进角色事实**（"最近在学做点心"等）
- 视角标记：events.perspective 默认 'interaction'，生活事件回写标 'self'；read() 可按
  perspective 过滤——召回"昔涟自己的经历"与"和用户的互动"分开
- retention_bias 语义转向角色性格（8-28）：从"微微偏向正面(讨好)"改为"昔涟作为三千万世的
  人对什么记忆更深"——默认值 0.2 不变，PersonaAdapter prompt/spec 描述更新
- 摘要角色视角：conversations 加 character_perspective 列（ALTER + try-catch）——
  SessionEndProcessor prompt 要求"同时总结昔涟在这段对话中的感受/变化"

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
    summary_status  TEXT DEFAULT 'ok',   -- ★ 9-25 'ok' | 'failed'：失败时不写占位符（见 §7）
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
    updated_at      TEXT NOT NULL,
    source          TEXT DEFAULT 'seed'     -- 8-14: 条目来源 'seed'(角色包导入/seed) | 'self'(昔涟自写)
);
```

### 2.8 内容自进化（2026-08-14，change: content-self-evolution）

昔涟可往自己的持久内容库写新条目（新回忆/设定 → worldbook；新日常 → life 模板池），
**无事前审批**，安全靠事后：

- **写工具**（chat tools 注册，仅她自己的视角）：
  - `write_worldbook`：参数 `trigger_keys[]`（未来触发关键词）+ `content`（≤250 字）
  - `add_life_template`：参数 `activity` + `type`（chat/internal，默认 internal）
- **写入校验双段**：① 机械预检（content/trigger_keys 查重、长度 ≤250、触发词非空——规则最可靠先挡）；
  ② LLM 校验器（复用 llmService.complete，max_tokens 128、低温；判定 prompt 只给条目本身不给对话
  上下文；判定标准：只写关于她自己的事/她的世界、用户事实不写、模糊不写、离谱危险不写、与已有
  条目冲突不写）→ `{decision: write|reject}`。**校验器异常/超时 → 降级拒写**（宁可漏记不误记）。
- **通知 = 内容浮现，不是操作汇报**：无"我加了一条设定"元语言；工具 result 可见后，主循环 LLM
  把新内容当回忆/念头自然说出（生活陈述口吻）。沿用 personalize 语气，无需新通道。
- **审计双轨**：`logger.info('[SelfEvolve] …')` 硬记录（完整内容，可扫描 + 找回）；
  `source='self'` 标记 + webui 列表 = 软审计面。
- **删除仅响应明确用户指令**：`delete_worldbook_entry`（按 ID 或内容关键词）/ `delete_life_template`，
  description 硬约束 LLM 不得自主删除自己的条目；每次删除日志留完整内容（误删可从日志找回）。
  **不暴露 update**——她不可改写自己的历史，只能新增/应指令删除。
- **lookup_worldbook 实时化**：handler 每次调用从 db 实时查询（条目量小，成本可忽略），
  替换启动冻结的 index——自写条目即刻可查。
- **自写条目 role='alysia'、scope='chat'、source='self'**，入库即自然进入 worldbook 匹配
  （matchByKeywords）与 life 生成采样链（getWorldbookSample），她的新设定影响她后续过什么日子。

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
  → 四路并行向量检索（conversation / knowledge / chat事件 / life_event）
  → SQLite 结构化查询 (profile + persona + code_context)
  → 合并选稿（保底配额 + 相对阈值 + 文本去重）
  → 组装返回
```

**★ 2026-09-25 实际行为（change: optimize-recall-pipeline）**

**① 距离度量 = 余弦**（`LanceDBStore.search` 显式 `.distanceType('cosine')`）。
原用 L2 + `score = 1 − d`：单位向量下 L2 = √(2−2cos)，**d=1（cos 仍 0.5，明显相关）
时 score 就被 clamp 成 0** —— 可用区间只剩一半，实测导致长文本来源分数全塌、
全局排序失效。换余弦后 `1 − _distance` 直接是余弦相似度。
⚠️ 表当前**无向量索引**（暴力扫描）才可自由换度量；将来建索引必须也用 cosine。

**② 合并 = 保底配额 + 分数补位**（`mergeWithQuota`），不是全局 sort 后 slice。

> **为什么**：**路内排名可信，跨路比绝对分不可信** —— 不同来源的文本长度分布不同
> （生活事件是 2-4 句长微叙事、聊天是短问句），长文本与短查询的嵌入天然更远。
> 全局 sort 等于让"文本短的来源"系统性获胜。实测 46 条 `life_event` 在 6 个话题里
> **一条都进不了最终 5 条**，尽管它们路内排名第一。
>
> 策略：每路先保底 top-1（保证"她的生活 / 过往对话 / 知识"都有代表）→ 剩余名额按分数补。
> 代价：`limit=5` 且四路都有候选时会**固定注入 1 条生活事件** —— 这是有意的
> （"她有自己的生活"是系统核心），需要排除时用 `perspective: 'interaction'`。

**③ 路内相对阈值** `RELATIVE_KEEP = 0.7`：某条低于「该来源最佳 × 0.7」则丢弃。
**用相对而非绝对**，因为不同来源的绝对分不可比（绝对阈值会把长文本来源整路误杀）。

**④ 文本去重**：同一段内容会以两个来源各存一份（`type='chat'` 的生活事件既被
`recordLifeEvent` 嵌成 `life_event`，又被推送后经 `RealtimeProcessor` 嵌成 `chat`；
实测 47 条 life_event 里 23 条重复）。**不去掉写入端的重复** —— 那两份语义不同
（"她的生活" vs "她对你说的话"），`perspective` 过滤依赖这个区分。
只在选稿阶段按归一化文本去重，且 `life_event` 组排前面让语义更具体的标签胜出。

**⑤ 排序 = 乘性衰减**（`applyKnobsToRetrieved`）：
`score × (1 − recency_weight × ageFactor × 0.5)`，其中
`ageFactor = 1 − e^(−ageHours / halfLife)`、`halfLife = 24 / decay_rate`。
另有 `importance > importance_threshold → +0.15`。

> ⚠️ **对账分歧（未决）**：上一版本节写的是加权融合
> `向量距离 × 0.5 + 时间衰减 × 0.3 + 重要性 × 0.2` —— **该加权形式从未实现过**，
> 一直是上面的乘性衰减。按对账规则（doc 已声明 impl 没接 → 改 impl）应补实现，
> 但 `重要性` 当前**没有数据来源**（见⑥），无法完整实现。
> **待定**：补加权融合 vs 认可现状改 doc。

**⑥ `importance` 已接线（2026-09-25, wire-importance-signal）**

接线前：列存在、`EventStore` 读写它、`+0.15` 分支也在，但**四条写入路径没有一条写有效值**
（唯一赋值是 `llm-agent.ts` 给她自己回复硬编码 `0.3`，且没进向量 metadata），
实测分布 `0.3`(481)/`0`(445)，分支从未执行。

**信号来源（用户拍板）**：

| 对象 | 信号 | 算法 |
|---|---|---|
| **生活事件** | **情绪强度** | `memory/importance.ts`：基线 0.3 + 情绪加成 0~0.4（`moodDelta` → 强度），`origin='followup'` ×0.8 |
| **对话消息** | **摘要时 LLM 顺带打分** | `SessionEndProcessor` 的同一次摘要调用多要 `important_moments[{quote, importance}]`，按**原文摘句子串**匹配回事件 |

生活事件的 `moodDelta` **取的是 arousal（唤醒度）而非 valence** ——
"平静"与"雀跃"的差别是强度；负面情绪（难过/生气）同样值得记住，也给高值。

实测取值：雀跃 0.66 / 平静 0.36 / 无标记 0.30 / 对话余波(+1) 0.56 ——
相对默认阈值 **0.4** 有区分度（接线前恒 0，全无区分）。

⚠️ 系数是**启发式**，全部提成具名常量（`LIFE_BASE` / `LIFE_EMOTION_MAX` / `FOLLOWUP_FACTOR`）
便于调参。`mood_delta` 真实数据格式很乱（`+1`/`+0.001`/`平静`/`warm` 混用，数字尺度差三个数量级），
本实现**不做尺度校准**（无基准可比），靠基线兜底。

**写入侧**：`recordLifeEvent` 写进向量 metadata（`ai_life_events` 无此列，**不改表**）；
`RealtimeProcessor` 补上了原先漏传的 `event.importance`。
`SessionEndProcessor` 回填后**重新嵌入刷新向量 metadata**（召回读的是那里）。

**消费侧**：`applyKnobsToRetrieved` 的 `importance > importance_threshold → +0.15`；
`ProfileExtractor` 启用原 TODO 写明的过滤（带安全下限：过线不足 3 条则回退用全部，
防止重要度稀疏饿死画像提取）。

**⑦ `confirmation_bias` / `retention_bias` 未接线**：需要"记忆的情绪极性"与
"与既有信念的冲突度"，当前数据里都没有。硬接会变成和 `importance` 一样的空转旋钮。
（`retention_bias` 的语义已在 8-28 转向角色性格，见 §2.2）

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

**★ 手动纠正契约（2026-10-16，change: `add-memory-correction`）**

用户在 Web 端点一条事实说"这不对"，语义与上面的冲突解决**同一条**，但**触发者是人**：

`MemoryManager.correctProfileFact(oldFact, newFact) → { superseded, added }`

- **必须是「先作废旧、再写入新」两步，且一起做。**
  ⚠️ **不许退化成只 `addFacts([新])`**：冲突检测靠 `normalizeKey` 的**文本相似**，
  而「用户在长沙」→「用户在上海」**并不相似** ⇒ 不会互相 supersede ⇒
  **两条同时 active** ⇒ 召回同时拿到，用户看到**自相矛盾的她**。
  （已有一条用例把"只 addFacts 会两条并存"固化成前提，防止后人简化掉。）
- 新事实写 `source: 'user'`、`confidence: 1.0`，与 §4.x 的**纠正快路径**
  （`RealtimeProcessor` 检测纠正信号 → 旧条 superseded → 新条 source=user/1.0）**同语义**。
  `source='user'` 同时保证它**不会被后续 `inferred` 提取顶掉**（上面第 4 条）。
- **`superseded: false`（没找到旧事实）不是失败**：旧文案可能已被改写过，
  此时**新事实仍要写入**，并**如实**告诉用户"旧的没找到，但新的记下了"——
  不许说成"替换成功"，也不许说成"失败"。
- **空的新事实 → 抛错**，且**不得**留下"旧的已作废、新的没写入"的中间态
  （所以校验必须在作废之前）。
- **纠正不删除**（与冲突解决一致：留审计链）。因此 `getProfileSnapshot` 新增
  `{ includeSuperseded }`：纠正页要能**看见被作废的那条**，否则用户只能相信按钮上那句话。
- ⚠️ **首版只覆盖用户事实**（`facts`）。角色事实（`character_facts`）**只读** ——
  `ProfileStore` 没有"按 key 作废角色事实"的方法；需要时单独加，
  **不许**在前端假装失效（那会让用户以为改掉了、其实没有）。

### 4.1.1 画像链路的采样槽契约（2026-10-01，change: fix-profile-extract-empty-response）

> 本条来自一次**静默停摆 6 个月**的故障：用户说过的所有事实从未进入画像，
> `[关于你]` 段永远为空。根因不是逻辑错，是**两个契约被同时违反**。

**链路上的三个 LLM 调用，各吃一个槽：**

| 调用方 | 槽 | 输出契约 | prompt 含 "json" |
|---|---|---|---|
| `ProfileExtractor.extract` | `profile.extract` | **JSON** | ✅ `返回JSON` |
| `PersonaAdapter.processSignal` | `profile.extract` | **JSON** | ✅ `返回JSON` |
| `CronProcessor.deepProfile` | `profile.deepRewrite` | **纯文本** | ❌ `返回纯文本总结` |

**契约 1：`max_tokens` 是可见内容与 reasoning 的共享预算。**

`CHAT_MODEL` 是推理模型，每次调用先花掉一笔 reasoning token，**与 content 共用同一个
`max_tokens`**。预算给小了 → reasoning 吃光 → `content` 为空、HTTP 200、
`finish_reason: length` → 服务层抛 `empty response`。

- 这条已造成三次线上故障：会话摘要（22 天 100% 失败）、每日反思（11 次空响应）、
  画像提取（长期静默停摆）。
- **要求 LLM 产内容的结构化槽位，`max_tokens` 不得低于 2048。**
  `tests/provider/sampling.test.ts` 有守卫，调小即测试失败。

**契约 2：`response_format: 'json_object'` 要求 prompt 里含 "json" 字样，否则 API 400。**

判据是该槽**全部消费者**的输出契约，不是「槽看起来像不像结构化任务」。
`profile.extract` 与 `profile.deepRewrite` 必须分开，正是因为前者的消费者全产 JSON、
后者产纯文本——**共用一个槽会让任一方都活不了**（开 JSON 模式则 deepRewrite 被 400 拒；
不开则 extract 只能裸 `JSON.parse`，遇 markdown 围栏即失败）。

**契约 3：`ILLMService.complete` 的第三参 `sampling` 必须生效。**

`MemoryManager` 用 `slotify(slot)` 按场景绑定槽位。实现方若**少声明一个形参**，
TS 不报错（少形参可赋给多形参签名），但槽位会被静默丢弃——
所有调用塌回实现自己的默认槽。`OpenAILLMService` 曾如此。

**契约 4：所有 LLM 结构化输出必须走共用解析器 `utils/llm-json.ts`，且解析失败必须留痕**
（2026-10-16，change: `fix-persona-adapter-json-tolerance`，KI-4）。

| 规则 | 为什么 |
|---|---|
| 禁裸 `JSON.parse(response)` | 模型即使被要求"只输出 JSON"也常包一层 ` ```json `；裸 parse 遇围栏直接抛 |
| 统一用 `parseLLMJson()`（剥围栏 + 空判 + 截断检测 → `json`/`bare`/`empty` 判别联合） | 这个需求在本仓**出现过两次、只做对了一处**——线上后果是**会话摘要 22 天 100% 失败**（见该文件头注） |
| 解析不出来（`bare`/`empty`）→ **必须留痕**（限频 warn） | 「模型说了句人话」与「自适应静默失效」**不许同形**——这正是 KI-4 藏了很久的原因 |
| 「合法 JSON 但内容不合法」（如 `adjustments` 不是数组）→ 返回 null，**不算解析失败** | 报 warn 会把真失败淹掉 |
| 「合法 JSON 且语义上无需调整」（如 `adjustments: []`）→ 正常结果，**不报警** | 同上 |

⚠️ **当前的实现分布**（改动时要一起想）：`ProfileExtractor`、`SessionEndProcessor`、
`PersonaAdapter` 都已改用共用解析器。**新增任何 LLM 结构化消费方都必须照办**，
不要再抄一份 `JSON.parse`。

**契约 5：记忆必须有**显式渠道字段**（`channel`），且**写入时**落库**
（2026-10-16，change: `add-memory-channel-field`）。

背景：后续要让昔涟**从 QQ 侧调用 dsh 编程工具** ⇒ QQ 日常对话与 dsh 编程会话在同一套库里
并存，且**将来要特殊处理**（差异化召回 / 注入策略）。

| 规则 | 为什么 |
|---|---|
| `events.channel` / `conversations.channel`：`'qq'\|'dsh'\|'webui'\|'unknown'` | 渠道必须是字段，不是"猜出来的" |
| **写入时**落库（`insert` 里算），不靠事后反推 | 否则要等下次启动的回填兜底 = "看起来对、其实靠重启" |
| 判不出来写 **`'unknown'`**；`''` 只表示"还没回填" | 两者语义不同，混起来就分不清"判不出"与"没跑迁移" |
| 派生判据只在 `utils/channel.ts`（一处，有测试锁） | 判据分叉就是这个仓库反复栽的坑 |
| ⚠️ **`events.source` 不是渠道**：它是 `chat`/`code`（事件性质） | 实测 730 条 dsh 事件里 **28 条**是 `source='chat'`（用户消息）—— 用 `source='code'` 判 dsh **会漏 28 条** |
| ⚠️ 也不要把 `session_id` 前缀当作**唯一**渠道来源 | 前缀是脆的：dsh 拿不到 `session.id` 时退化成 `dsh:unknown`，多会话挤一个桶（KI-23） |

**结构化记忆条目也要有渠道**（同上 change，同一契约）：

| 对象 | 字段 | 写入点 | 值怎么来 |
|---|---|---|---|
| `facts` / `character_facts` 条目 | `channel` | `ProfileExtractor.toFact` | 起源事件在手里 ⇒ `channelOfSession(events[0].session_id)` 如实派生 |
| `adaptation_hints` 条目 | `channel` | `PersonaAdapter.apply()` | **穿参**：调用方（两个处理器）传事件渠道；情绪漂移传 `life`；24h 回归传 `system` |

⚠️ **`source` 与 `channel` 是两个轴，不许互相顶替**：`source` 是**提取方式**
（`user`/`behavior`/`inferred`），`channel` 是**从哪个入口来的**。

⚠️ **枚举必须够用**：`life`（她自己的生活管线）与 `system`（系统发起）是**独立取值**。
若把这两者塞进 `unknown`，就与"**判不出来的老数据**"混成同一个值，
而处理策略相反（前者是设计行为要保留，后者是数据债要回填或忽略）。

⏳ **存量条目的回填刻意不放在启动路径**（`initializeDatabase`）：这三样是 JSON 列，
回填要整列 parse + 重写，每次启动做一次不可接受；而它本质是**一次性数据修复**，
应当离线、可 dry-run、可核对 —— 恰好与 KI-20 的清理/合并是同一次操作，
届时新增的 dsh 条目就地打标、老条目按 `source_event` 形态补标，判不出记 `unknown`。

语义是**替换**默认槽，不是合并（否则调用方无法摆脱默认槽的字段，例如去掉 `json_object`）。

**契约 4：这条链路上禁止裸 `catch {}`。**

`ProfileExtractor` 与 `CronProcessor` 都曾用裸 `catch` 吞掉失败——失败与
「正常但没提取到」在日志里长得一模一样，这是它停摆 6 个月无人察觉的直接原因。
**提取类失败必须 `logger.error`**：一次失败 = 这一批事件的事实永久丢失。

#### 4.1.2 ★ 推理预算的观测契约（2026-10-02，change: add-llm-budget-observability）

> §4.1.1 规定了「预算要够大」，但**没规定「怎么知道它够不够」**。
> 后果：`docs/KNOWN-ISSUES.md` 的 KI-1 / KI-2 长期**无法判定**——
> 不是"没发生"，是**证据拿不到**。本条补上这一环。

**契约 1：provider 必须透出 `finish_reason` 与 `reasoning_tokens`。**

`LLMResponse` 携带 `finishReason`（`choices[0].finish_reason`）与
`usage.reasoningTokens`（`usage.completion_tokens_details.reasoning_tokens`）。
字段缺失（非推理模型 / 老响应）**降级为 `undefined`，不得报错**。

**契约 2：每次 LLM 调用都要在日志里留下预算现场——写在 provider 层，不写在各槽位。**

`OpenAIProvider.textChat` 的成功日志必须含 `finish=` 与 `reasoning=`；
**空 content 时单独 `logger.warn`**，并直接区分「预算耗尽」与「不是预算问题」。

> **为什么写在 provider 层**：所有槽位都流经同一处，**一处改即全局覆盖**；
> 逐个槽位打点会在**新增槽位时漏掉**——KI-2 的 `proactive.personalize` /
> `vision.describe` 正是这么漏掉观测的。

> ⚠️ **「所有槽位都流经同一处」只对聊天链路成立。** 记忆系统（会话摘要 /
> 画像提取 / cron 深度重写 / 人格调整）走的是**第二个客户端**
> `modules/resources.ts` 的 `al:memory-llm`（`resources.ts` 直连 `fetch`，
> 刻意绕开 ProviderManager）。它由 **§4.1.3 契约 5** 单独约束。
> 读日志时注意区分：聊天链路 `[LLM]`、记忆链路 `[LLM:memory]`。
> （2026-10-11 `instrument-memory-llm` 补记：该前提原先写漏了，导致会话摘要槽的
> 失败恰好落在观测盲区里。）

**契约 3：`role: 'err'` 不得被压成空串。**

调用方（如 `modules/life.ts` 的事件生成回调）拿到 `role === 'err'` 时
**必须记日志并保留错误信息**。直接 `return ''` 会让上层只看到 `empty response`，
把**网络故障伪装成「模型没输出」**，排查方向直接被带偏
（违反「不静默吞错」与「降级必须可区分」两条既有约定）。

**契约 4：判定口径（改预算数字的前置条件）。**

| 观测 | 含义 | 动作 |
|---|---|---|
| `finish=length` + `content` 为空 | **预算被推理吃光** | 该槽要更大的 `max_tokens` |
| `finish=stop` + `content` 为空 | 不是预算问题 | 另查（prompt / 模型行为） |
| `finish=?` / `reasoning=?` | 字段缺失 | 非推理模型或响应格式变了 |

**没有这两项观测就不许改预算数字**——凭感觉填正是本项目反复吃亏的地方
（§4.1.1 那三次故障都是这么来的）。

#### 4.1.3 ★ 记忆链路 LLM 客户端的观测契约（2026-10-11，change: instrument-memory-llm）

> §4.1.2 契约 2 的前提「所有槽位都流经 provider 层」**与实现不符**：
> 记忆系统走的是 `modules/resources.ts` 的 `al:memory-llm`——**第二条链路**。
> 它此前一条日志都不打，于是线上持续发生的摘要槽失败
> （8 天 10 次「LLM 返回空响应」+ 4 次 `truncated=true`）
> **恰好落在观测盲区**，契约 4 的判定口径对它完全失效。

**契约 5：`al:memory-llm` 必须与 provider 层同款留下预算现场。**

`modules/resources.ts` 的 `memoryLlmModule.complete()` 成功路径必须打一行：

```
[LLM:memory] <model> → <内容摘要> tokens=<in>+<out>=<total> finish=<stop|length|?> reasoning=<n|?> (<Xms)
```

- `content` 为空时**单独 `logger.warn`**，文案必须区分
  `finish=length`（预算被推理吃光 ⇒ 该槽要更大的 `max_tokens`）与
  `finish≠length`（**不是预算问题**，另查）。
- `usage` / `completion_tokens_details` / `finish_reason` 缺失时**降级为 `?`，不得报错**
  （非推理模型 / 老响应）。
- 日志标签**必须是 `[LLM:memory]`**，与聊天链路的 `[LLM]` 区分——
  两条链路的失败处置不同（前者用户可感知，后者是静默的记忆质量），
  混在同一标签下会让 token 统计与失败归因都失真。
- 观测点必须在**客户端**而不是各槽位：会话摘要 / 画像提取 / cron 深度重写 /
  人格调整**四个槽位共用这一个客户端**，逐槽打点会在新增槽位时漏掉（同契约 2 的理由）。

**契约 5 的边界（2026-10-11 下午更新）**：本条只约定**观测**。
该客户端当时**没有超时 / 没有 signal / 没有 fallback**，但——
★ **「没有超时」不再是可接受的边界**，见下面的**契约 6**。
（`fallback` 仍属收编 ProviderManager，仍是独立 change。）

> **判定口径与契约 4 完全一致**，两个客户端用同一套读法：
> `finish=length` + 空内容 ⇒ 预算吃光；`finish=stop` + 空内容 ⇒ 另查。

**契约 6：`al:memory-llm` 必须有超时，且超时必须抛错而不是返回空串。**
（2026-10-11，change: add-memory-llm-timeout）

> 背景：契约 5 上午刚落，把「没有超时」记成了**刻意保留的边界**；
> 同日下午线上就证实该边界会**把请求挂死 117 分钟**（KI-21，`extractProfile (7039529ms)`）。
> 观测一上线就推翻了「边界」这个说法——这正是先补观测的价值。

**契约 6.1：超时值 = 120s。**

聊天链路（`provider/openai.ts`）是 **60s**——那是**交互式**延迟预算（用户在等回复）。
记忆链路是**批处理**（会话摘要 / 画像提取 / cron 深度重写），
输出契约更长（`profile.extract` 为 `max_tokens: 4096` 的结构化 JSON），
已观测合法耗时可达 `29705ms`。故取 **120s**：对合法调用有充分余量，
同时把「无限等待」压到 2 分钟。**硬编码，不做配置项**（与 provider 的 60s 一致）。

**契约 6.2：超时必须抛错，消息可区分。**

超时**不得**返回空串。返回空串会流经 `parseLLMJson` → `kind:'empty'`，
让上层只看到「LLM 返回空响应」——**网络故障被伪装成「模型没输出」**，
正是契约 3 禁止的抗模式。超时错误消息必须含「超时」字样与秒数
（实现为 `LLM 请求超时（120s）`）。

**契约 6.3：超时同时必须 `abort()` 底层 fetch。**

只抛错不 abort 会**泄漏连接与 socket**。实现用 `AbortController` +
`Promise.race`（与 `provider/openai.ts` 同款）——后者是必需的，
因为 `AbortController` **无法中断 DNS / 连接建立阶段**（见 `llm-request-timeout-race`）。
成功路径也必须 `clearTimeout`，否则进程会挂着一个空转的定时器。

**契约 6.4：超时是「延迟」而非「数据丢失」。**

超时抛错后走既有链路兜底：会话摘要重试 1 次 → 仍失败落 `summary_status='failed'`
→ cron 的 `retryFailedSummaries()` 后续补处理。
**任何一次超时都不得导致某个窗口被永久跳过。**

### 4.2 人格自适应引擎

触发源:
- 用户直接反馈（"你太啰嗦了"）
- 行为隐式信号（反复打断、话题频繁跳转）
- 对话模式变化（技术讨论 → 闲聊）
- ★ 8-28 情绪惯性漂移（memory-character-perspective）：生活事件累积 mood_value 驱动
  自然漂移——连续开心（mood_value≥15 正向）→ playfulness 微升；连续低落（≤-15 负向）→
  empathy 微升；Δ=0.05，走 apply 5 道护栏（|Δ|≤0.1/冷却/同向次数/24h 回归/显式指令 bypass）。
  触发点：LifeService.updateMoodValue 极性跨 ±15 阈值时（经 MemoryManager 暴露调用）——
  人格来源从"只有用户反馈"变成"用户反馈 + 情绪累积"

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

### 4.7 存储写入留痕契约（2026-10-02，change: `fix-migration-and-logger-silent-failure`；**2026-10-16 扩写，change: `fix-store-write-trace`**）

> 起因：`life.generateEvent` 的预算观测补齐后（§4.1.2），顺带审计了**全部存储节点**
> （9 个 store / 55 个写入点）。结论：**留下可查痕迹的接近 0**。
> 本条先落**最基础的两条**——它们是「其他所有日志是否还有意义」的前提。
> 完整审计发现见 `docs/KNOWN-ISSUES.md` 的 KI-5 与 KI-11～KI-17。
>
> ★ **2026-10-16 第二刀（`fix-store-write-trace`）落地 KI-12～KI-17 与 KI-5 剩余**，
> 新增**契约 4～10**（0 行定性回写 / 向量失败可判 / 摘要与向量分开记账 /
> 读兜底不回写 / 状态默认值指向失败可见 / 导入原子性 / 裸 catch 处理手法）。

**契约 1：迁移必须「探测式幂等」，不得用裸 `catch` 表达幂等。**

旧写法是：

    try { db.exec('ALTER TABLE persona ADD COLUMN x TEXT'); }
    catch { /* column already exists */ }

那句注释是**假设，不是验证**。它把两种情况压成同一个静默分支：
「列已存在」（正常的幂等跳过）与「锁库 / 磁盘满 / 权限不足」（**迁移真失败**）。后果链：

    迁移静默失败 → 列没加上 → 进程照常启动、启动日志全绿
      → 直到某次写该列才报 no such column
      → 而读到 undefined 时又走「回落默认值」
      → 「库结构不对」长期伪装成「还没有数据」

正确写法是**先探测再执行**：

    addColumnIfMissing(db, 'persona', 'x', 'ALTER TABLE persona ADD COLUMN x TEXT');

- 列已在 → 跳过（幂等）；否则执行，**失败原样抛出**（大声）。
- **禁止靠错误文案匹配**（如 `err.message.includes('duplicate column')`）：
  SQLite 换版本改了措辞就静默失效，**比裸 catch 更隐蔽**。
- **`addColumnIfMissing` 是迁移加列的唯一入口**，新增列只有这一种写法。
- 「列已存在」不是错误，是**幂等成功**——所以这里**不需要 catch**，
  也就不会再有裸 catch。

**契约 2：日志子系统自身的失败必须能喊出来。**

`utils/logger.ts` 的 `writeFileLine` / `configure`（`mkdirSync`）/ `cleanupOldLogs`
三处失败**不得静默**：

- **直写 `console.error`，不得调 `logger.*`** —— `fmt()` 内部就是
  `console.log` + `writeFileLine`，会无限递归。
- **只在第一次喊**（标志位）：磁盘满会持续失败，每次都喊会把 stderr 刷爆，
  反而淹没别的信息。
- **成功写入后复位标志位**，使故障恢复后能再次告警。

这是整条可观测性的**地基**：磁盘满时，**所有「有痕迹」的路径会集体变成「无痕迹」，
而这个失败本身也无痕迹**。

`catch` 本身保留是对的（文件写坏不该拖垮进程）：
**不吞的是「知道」，不是「异常」**——区别在于现在它会喊。

**契约 3：写入影响行数先「观测」，再「定性」——不许跳过证据直接硬校验。**

`UPDATE … WHERE id = ?` 命中 0 行**不报错**——「改到了」与「什么都没改」完全同形。
这是本项目栽过三次的「空转伪装成归档」的产地（`docs/KNOWN-ISSUES.md` KI-11）。

**但 `changes === 0` 有两种含义，且静态分不出来：**

| 含义 | 例子 | 该不该报错 |
|---|---|---|
| **正常**：幂等跳过 | `INSERT OR IGNORE` 遇到已存在的行 | ❌ 不该（会变成噪声） |
| **异常**：目标行不存在 | 写错 id / 行被并发删除 / **表结构不对（列没迁上）** | ✅ 该 |

一刀切硬校验会把正常路径变成噪声，**比现在更糟**。所以分两步走：

1. **观测（change: `observe-zero-row-writes` 已落地）**：在「0 行可疑」的写点调用
   `traceZeroRows(tag, changes, context?)` —— 命中 0 行时打一行
   `[WriteTrace] <类名.方法名> 命中 0 行 — <上下文>`。
   - **只观测，不拦截**：不 `throw`、不改返回值、不改控制流、不改 SQL。
   - **必须用 `warn`，不得用 `debug`** —— `debug` 被 `ALYSIA_DEBUG` 门控、产线不输出
     （`LifeStore` 唯一那行日志就是这么变成"等于没有"的）。
   - **幂等插入不接**（`INSERT OR IGNORE` / `INSERT OR REPLACE`）：它们为 0 行是设计意图。
   - 已接：`LifeStore`（`updateState`/`markDelivered`/`deferIntent`/`markIntentStatus`/`deleteTemplate`）、
     `WorldbookStore`（`recordTrigger`/`updateEntry`/`deleteEntry`）、
     `EventStore`（`markProcessed`/`updateImportance`/`archiveBySession`/`deleteBySession`）、
     `ConversationStore`（`updateSummaryResult`/`deleteBySession`）、
     `KnowledgeStore`（`archive`/`deleteDoc` ×2）、
     `PersonaStore`（8 个 `WHERE is_active = 1` 写方法，走私有包装 `updateActive`）。
2. **定性（`tune-zero-row-checks`，等运行数据）**：按 tag 聚合统计 0 行发生率，
   逐点判定「显式豁免」或「升级为硬校验（`logger.error` + 返回失败，让调用方能判）」。
   **定性结果要写回本条**，形成「逐点口径表」。

**判定铁律**：**没有跑出来的分布，不许改判断逻辑**——与 §4.1.2 的
「没有观测就不许改预算数字」是同一条纪律。

**契约 4：0 行「逐点定性」结果表（契约 3 第 2 步的回写）。**

`tune-zero-row-checks` 的决策入口仍在（按 tag 聚合分布）。
**已定性为「硬校验」的点**（调用方能判，不只是观测）：

| 写点 | 定性 | 依据 |
|---|---|---|
| `ConversationStore.updateSummaryResult` | ✅ **硬校验**：返回 `{ rows, vector }`，**`rows === 0` 即非成功** | 2026-10-16：`retryFailedSummary` 原先不看 `changes`，0 行时照样打「补处理成功」+ `return true`，调用方据此 `ok++` ⇒「什么都没改」被记成「补好了 N 条」。**它与「幂等跳过」不同**：这是「补处理一条已存在的失败行」，行不存在就是真异常 |

其余点**仍按契约 3 观察**，不得凭感觉改成硬校验。

**契约 5：向量库的失败必须让调用方能判。**

`IVectorStore` 的实现**不得自己吞掉失败**：

| 方法 | 成功 | 失败 |
|---|---|---|
| `insert` / `delete` | resolve | **reject** |
| `search` | 结果数组，**`[]` = 确实没有匹配** | **reject**（不许用 `[]` 冒充故障） |
| `count` | 条数 | **reject**（不许用 `0` 冒充「库是空的」） |

「不可用」（没装 / 打不开）也是失败，用 `VectorStoreUnavailableError` 区分，
让调用方**自己决定**是否降级到文本检索。**降级是调用方的决定，不是实现的擅自省略。**

依据（2026-10-16，KI-14）：旧 `LanceDBStore` 把四类失败全吞了，后果是**层层伪装**——
① 上游每一处 `try { insert } catch { warn }` 都成**死代码**（真 store 永不抛），
2026-09-27 的回填脚本 `done++` 计的就是「没抛异常」，一条向量没写也照样打全绿；
② `search` 的「故障」与「无匹配」同形 ⇒ 文本降级永不触发；
③ `count` 的「读不了」与「空库」同形 ⇒ 它没法当健康检查判据。

**契约 6：摘要与向量**分别**记账。**

`summarized` 只说明摘要行写成了；向量是**另一条链路**，它失败时行仍是
`summary_status='ok'`。所以：

- `SessionEndResult` 带 **`vectorOutcome`**：`stored` / `no-store` / `no-vector` / `failed`
- 批处理日志（`archiveStaleSessions`）必须报
  `archived N/M …（向量：成功 X / 无库 Y / 失败 Z）`，**全部 stored 才不加尾巴**
- 逐条写向量失败的路径（`importKnowledge` / `applyImportantMoments`）在末尾报总账，
  不逐条刷屏

依据（KI-15）：「摘要在、向量一条没有」与「都写好了」在日志上曾**完全一样**。

**契约 7：读兜底不得回写默认值（兜底与回写分离）。**

**读可以给默认值，但不许把默认值写回去。** 真要修库里的值，走**显式**入口并**留痕**。

依据（KI-16）：`PersonaStore.get()` 曾检测到空列就 `UPDATE` 回结构默认值 ——
把「人格被冲成空」**整形成一组合法出厂默认值**（与 seed 逐字相同），
骗过数据层也骗过人工巡检，且调用方不知道自己触发了一次写。
现在：`get()` 只填返回值；`repairEmptyColumns()` 是唯一的显式修复入口，
由 `al:persona-seed` 在启动时调用并把修复的列名喊出来。

**契约 8：状态默认值必须指向「失败可见」，0 行更新不算成功。**

- `conversations.summary_status` 的**写入默认值是 `'failed'`**（读侧 NULL 亦同）。
  漏传状态的路径必须「可见且可补」：`getRecent()` 不注入空摘要、
  `retryFailedSummaries()` 会捞出来补。
  **理由**：默认 `'ok'` 会让任何新导入/迁移路径漏传时写出「空摘要 + 状态 ok」——
  那正是线上「22 天 100% 失败却全绿」的同款构造。
- 「应当更新目标记录却命中 0 行」时**不得报告完成**（见契约 4）。

**契约 9：导入必须原子，重试必须校验完整性。**

- 文档元数据与**全部 chunk 在同一个事务里**写（抛错整体回滚）⇒ **残壳不可能存在**；
- `chunk_count` 用**实到块数**（由事务内真正插入成功的条数回填），
  **不许先声明一个尚未兑现的块数**；
- hash 去重**命中不等于完整**：必须核对
  ① `status === 'active'`（归档的不算已导入）② 实际块数 > 0 且 `=== chunk_count`；
  不完整则 **warn + 清残壳 + 重新导入**（docId 由 hash 决定 ⇒ 向量 id 不变，重建即覆盖）。

依据（KI-13）：旧实现留下 `status='active'` + `chunk_count` 虚高的「完全正常的活跃文档」外壳，
**零日志、永不自愈**；重试被 `getByHash` 命中 ⇒ 返回**从未兑现的块数**并宣布「已导入 N 块」。

**契约 10：裸 `catch` 的处理手法（没有例外）。**

三选一，**不许留裸 catch**：

1. **能改探测式的改探测式**（如迁移加列走 `addColumnIfMissing`）——
   「已经存在」是幂等成功，不是错误，所以根本不需要 catch；
2. **改不了的至少喊一次**：`logger.warn` 带**真原因**与上下文。
   ⚠️ 用 `warn` 不用 `debug`（`debug` 被 `ALYSIA_DEBUG` 门控、产线不输出）；
3. **热路径（每轮对话 / 每条消息）上的失败**用
   `warnThrottled(tag, message, limit=3)`（`utils/write-trace.ts`）——
   前 `limit` 次喊、之后静默，但**事件本身仍会重试**（不缓存失败结果）。
   依据：`add-ops-health-report` 的前置就是「96.6% 是 QQ 噪声」，日志被淹等于没有日志。

**不算裸 catch 的两类**（改了才是 bug）：

- **有意的语义回退**：如 `PromptAssembler` 里「basics 不是 JSON → 当纯文本摘要片段」，
  那不是失败，是设计；
- **幂等跳过**：`INSERT OR IGNORE` / `INSERT OR REPLACE` 命中已有行。

⚠️ **特别提醒**：读函数**自己的**裸 catch 会把「文件读不到」与「文件本来就是空的」压成同一件事
（2026-10-16 查明 `persona/loader.ts` 的 `readPersonaFile` / `readWorldviewBlock` /
`readWorldbookFile` 就是这样——**人格核心静默缺失**，与 `fix-role-import-wipes-persona`
是同一类事故）。**调用方的 catch 不能替你发现它**：`readWorldviewBlock()` 永不抛，
所以 `MemoryManager.getWorldviewBlock` 里那个 catch 是**死代码**
（且 `_worldviewBlock = ''` 中的 `''` 是 falsy，本来就会重试——
「永久缓存成空」的旧描述**不成立**）。**要在读函数内部喊。**

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

#### 5.4.1 ★ SessionEnd 三入口的窗口锚点契约（2026-10-11，change: fix-session-end-window）

> 上面第 2 条当时只描述了 **cron 路径**的锚点，从未声明另外两个入口可以不带锚点。
> 实现里它们**没传 `since`**，于是 `EventStore.getBySession` 落到
> 「全历史 `ORDER BY created_at DESC LIMIT 1000`」——线上 76% 的摘要窗口跨度 > 24h。

`MemoryManager` 有**三个** SessionEnd 入口，**每一个都必须传窗口锚点**：

| 入口 | 触发方 | 频率 |
|---|---|---|
| `archiveStaleSessions()` | cron 每 6h | 4 次/天 |
| `onSessionEnd(sessionId)` | 聊天回合 `usage.input > 8000`（`llm-agent.ts`） | 每次命中一次 |
| `extractProfile(sessionId)` | Web 端「提取画像」按钮 | 按需 |

**契约 1：锚点只有一处定义。**

```
since = ConversationStore.getLatestBySession(sessionId)?.ended_at
        无历史摘要 → 回退 24h 前
```

该规则必须由**唯一的 helper** 提供，三个入口共用。
「同一个规则写多份」正是本次故障的成因：cron 那份写对了，另外两份漏了。

**契约 2：不传锚点的 `process(sessionId)` 是 bug，不是合法用法。**

`SessionEndProcessor.process(sessionId, since?)` 的 `since` 缺省不是「从头开始」，
而是**「取该会话全历史最近的 1000 条事件」**（`EventStore.getBySession` 缺省
`limit=1000`、无窗口条件）。后果不是「稍微多摘要一点」，而是：

1. 窗口横跨数十天，同一段历史被反复摘要
   （线上实测：10-03 `12:10:00` / `12:10:45` / `12:11:24` 三条，间隔 45 秒，
   `started_at` 相差 1 分钟；29 条恰好 `message_count=1000`、跨度 **46~61 天**）；
2. 1000 条消息的 prompt 让摘要槽**稳定失败**
   （线上 8 天 10 次空响应 + 4 次 `truncated=true`）；
3. 单次耗时从 ~6s 涨到 **19~35s**；
4. 摘要经 `ConversationStore.getRecent()`（按 `started_at DESC`）注回 prompt
   → prompt 膨胀 → 更易命中 `usage.input > 8000` → **正反馈**；
5. 同一窗口的 `ProfileExtractor.extract` 被重复执行（同一天 6 次 = 6 倍提取成本）。

**契约 3：`archiveStaleSessions` 内的两个 `since` 语义不同，不得合并。**

- `getActiveSessions(since)` 的 `since` = **「24h 内有过活跃」的筛选门槛**
- `process(sid, anchor)` 的 `anchor` = **「上次摘到哪」的窗口起点**

两者数值常常不同（新会话无摘要时 anchor 回退 24h，而门槛始终是 24h）。
把二者并成一个变量会让「很久没说话的会话」被漏掉。

**契约 4：窗口**右边界**是数据边界，不是墙钟**（2026-10-16，change: `fix-summary-window-late-events`）。

`conversations.ended_at` = **本次窗口内最新一条事件的 `created_at`**；
**不得**取处理时刻的墙钟时间，且**不得晚于**处理时刻
（未来时间戳会把后续事件挡在窗口外 ⇒ 丢数据）。

字段语义因此明确为「**本次窗口覆盖到的最后一刻**」——与 `started_at`
（窗口内最早事件的时间）对称。墙钟时刻从不参与锚点计算。

理由（这是一条**已坐实**的缺陷，不是风格偏好）：`process()` 的窗口**只有下界**
（`getSessionEvents(sid, since)` → `EventStore.getBySession(sid, { since })`，无上界）。
若 `ended_at` 写墙钟 `now`，则**任何入库晚于其 `created_at` 的事件**
（dsh 在途消息 / QQ 重连补发 / Web 批量导入）在下一次都会落在
窗口之外，**永远不被摘要**；而那条摘要是 `summary_status='ok'`，
`retryFailedSummaries()` **不会补**。

**dsh 侧的具体可达路径**：dsh 回传队列**只在 `turn/end` / `session/disposed` 才 flush**，
所以一个**跨 cron tick 的长 turn** 就能让「上一轮已入库、本轮还在队列里」的会话
被 cron 先摘要 —— cron 是同进程定时器，**不经过适配器**，
**适配器侧的串行化（`dsh-adapter` §2.5.1 契约 5）管不到它**。
两个 change 是**互补**的：那个堵调用方抢跑，这个堵服务端定时器抢跑。

**为什么数据边界就够**：已入库事件是会话流的**前缀**（dsh 侧由 FIFO 保证），
所以迟到事件的 `created_at` **必然晚于**「已摘要的最新事件时间」
⇒ 它一定落在下一窗口内。顺带获得**幂等性**：
对同一批数据重跑摘要不会跳过任何东西。

**契约 4b：窗口是半开区间 `(since, until]`**（与契约 4 **必须同时成立**）。

`EventStore.getBySession` 的 `since` 是**开区间**（`created_at > ?`），
`until` 是闭区间（`created_at <= ?`）。

为什么必须与契约 4 一起成立：锚点现在**恰好等于某条事件的 `created_at`**
（就是这个会话里最后一条被摘要的事件）。若 `since` 是闭区间，
那条边界事件会被**相邻两次摘要各摘一遍**——重复计数、重复画像提取。
半开区间也给出了一致的**游标**语义：`since` = 最后一条**已**处理的事件，
下一窗口从它**之后**开始。

> ⚠️ 契约 4b **修订了 2026-09-26 的一个既有边界语义**（原为 `>=` 闭区间）。
> 当时 `event-window.test.ts` 明确写「边界语义是 `>=`……本 change 不顺手改成 `>`，
> 那是另一个语义决策，会改变摘要窗口边界」——**刻意推迟**了它。

**契约 4c：无历史摘要时，下界 = 该会话**最早的事件**（且不设时间上限）**
（2026-10-16，change: `fix-summary-anchor-floor`，KI-26）。

| 情形 | 下界 |
|---|---|
| 有历史摘要（`ended_at` 有值） | `ended_at`（契约 4） |
| **无任何会话记录** | **该会话最早的事件 − 1ms** |
| 有会话记录但 `ended_at` 为空 | **仍是 `now − 24h`（保守，不跟着放宽）** |
| 连一条事件都没有 | `now − 24h`（行为不变） |

三个要点，**缺一条都会出错**：

1. **必须 −1ms**：窗口下界是**排他**的（契约 4b 的 `created_at > since`）。
   若把下界设成"最早事件自己的时间戳"，**第一条会被 `>` 正好排除** ——
   "从头摘"反而漏掉开头。实测踩过：新鲜会话因此**一条摘要都不产**。
2. **不设时间上限**。旧实现用 `now − 24h` 兜底，代价是
   「消息全部早于 24h 的会话**一条都摘不出来**」，而且**永远够不着** ——
   下一次的锚点是"上一份摘要的 `ended_at`"，可上一份根本不存在
   ⇒ 每回都退回 `now − 24h`，而 now 还在往前跑。
   ⚠️ **别用「2026-10-11 的 46~61 天坏窗口」当理由加上限**：
   那次事故的**病因**是「三个入口都没传锚点 ⇒ **同一段历史被反复摘要**」，
   坏窗口只是**症状**；病因已被"锚点只此一处 + **摘完就前进**"堵死。
   加上限反而是把**静默永久丢失**换回来（且覆盖不到事故自己的症状场景）。
   单次窗口在**条数**上仍有界（`getBySession` 的 `LIMIT 1000`）。
   ⚠️ 残留风险：从未摘过且超过 1000 条的会话，最老那批这次仍够不到
   —— 彻底做法是**分块回填**（Backlog「历史画像回填」）。
3. **`ended_at` 为空的分支不许放宽**：那个分支**没有已知边界**，
   而 `getBySession` **不按 `processed` 过滤** ⇒ 窗口放宽多少就可能重摘多少。

**为什么"从头摘"不会二次摘要**：`getBySession` 不按 `processed` 过滤，
所以窗口锚点是唯一的闸；而该分支的前提是「**一条会话记录都没有**」
⇒ 这个会话**从来没被摘过** ⇒ 从头摘正是它该做的事。一旦摘过一次，
下界就变成 `ended_at`，**绝不回头**（有测试直接锁这一条）。

**契约 4d：同一会话的结算必须**互斥**，conversation id 必须唯一**
（2026-10-16，change: `fix-concurrent-summary-duplication`，KI-19 残余）。

两条缺一不可，且**顺序不能反**：

1. **per-session 并发互斥**（`SessionEndProcessor` 的 `inFlight` 集合）。
   两次调用若**重叠**（各自在对方落库前就算好窗口锚点），两次都会摘**同一批事件**
   ⇒ 同一会话出现**两条摘要**。锚点（`getLatestBySession`）只在**第一次落库之后**才前进，
   **挡不住重叠**。互斥命中时返回 `{ summarized: false, reason: 'in-flight' }` 并**限频留痕**。
   ⚠️ **重试路径不受影响**：那时第一次早已结束、不在飞。
2. **`conversations.id` 必须唯一**，不能只用 `conv-${sid}-${Date.now()}` ——
   同一毫秒的两次落库会做出同一个 id ⇒ 撞 PRIMARY KEY ⇒
   `UNIQUE constraint failed: conversations.id` ⇒ 异常抛给调用方，**后一次整段丢掉**。
   现在带一个 `randomUUID()` 短后缀。

⚠️ **为什么不"只把 id 改成唯一"就完事**：撞 PK 其实**歪打正着地挡住**了第 1 条的问题，
代价是"崩溃 + 丢一条"。只改 id 会把**响的错**换成**静默的重复摘要**——
拿一个更坏的错换掉一个更响的错。⇒ 互斥是**语义修复**，id 唯一只是**防御**。


> 契约 4 的 `ended_at` 数据边界化正是触发条件，故由本 change 兑现。

**被否决的替代方案**（各记一句，避免后人重走）：
① 让 cron 跳过 `dsh:` 会话 —— 会丢掉「dsh 崩溃、从未 `disposed` 的会话永不摘要」
这个 cron 本来要兜的场景，且治不了 QQ / Web 端的同源问题；
② 给窗口加「最近 N 分钟不摘」的宽限期 —— 治不了（问题不是「太近」，
而是锚点越过了尚未入库的数据）；
③ 让适配器上报「已 flush 水位」—— 要动 `/api/ingest` 契约并持久化水位，复杂度远超收益。

### 5.5 CR 修复（2026-08-29，change: cr-p0-session-isolation / cr-p0-delete-cleanup）

1. **会话摘要精确隔离**：ConversationStore.getRecent(limit, sessionId) 按**完整 sessionId
   精确匹配**（`session_id = ?`），不再按平台前缀 LIKE——旧实现 group 分支
   `LIKE '平台:group:%'` 会捞同平台所有群的摘要、private 分支 `LIKE '%:private:%'`
   跨平台混入（群 A 的聊天内容注入群 B 的 prompt）。EventStore 本就用 `=` 精确匹配，无同类问题。
2. **删除同步清向量**：deleteSession / deleteKnowledgeDoc 在删 SQLite 行后同步调用
   `vectorStore.delete(id)`（先取 id 再删，行删除后无法反查）；向量删除失败 warn 不阻断
   （日志可见，可后续重建）。已删内容不再被 [相关记忆] 召回。
3. **空 catch 补日志**（不静默吞错）：SessionEndProcessor 摘要失败 / RealtimeProcessor
   与 recordLifeEvent 的 embed 失败 / MemoryManager 向量检索失败降级文本 / importKnowledge
   chunk embed 失败——全部 `logger.warn(上下文 + err.message)`。

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
| **空查询不请求 embedding**（★ 2026-10-19，change: `fix-empty-embed-query`） | `query.trim() === ''`（dsh 会话挂载预热、系统组装）⇒ **直接走文本检索**，`debug` 级日志。真机证据：`[memory/read] query=""` 后面紧跟 `Embed API error 400 {"code":"1213","未正常接收到prompt参数"}` —— 智谱拒绝空 prompt。**没有查询文本就没有"语义相似"**，那次请求本来就不该发；不许"兜底成零向量"（零向量会返回随机相似的垃圾结果，比文本检索更糟）。`al:embed` 同样对空文本**不发请求**并抛明确错误 |
| LLM 提取失败 | 非实时，失败跳过，下次 cron 补处理 |
| **推理模型的 max_tokens 预算**（★ 2026-09-25 实测） | `CHAT_MODEL` 是**推理模型**：**reasoning 与可见内容共用同一个 `max_tokens`**，每次调用先花 ~250 tokens 在 reasoning 上。512 的预算下对话稍长即"预算耗尽、content 为空"（HTTP 200、0 字）。**要求结构化输出的槽位（`session.summary` / `life.generateSummary`）max_tokens 必须 ≥1024**。这同一个 512 曾同时造成「会话摘要 22 天 100% 失败」与「每日反思 11 次 empty response」 |
| LLM 返回非法 JSON（markdown 围栏 / 截断 / 空白） | 解析前**剥围栏**（共用工具 `utils/llm-json.ts`）+ 截断检测；失败重试 1 次（实测模型偶发空响应，重试可救回）；仍失败则**不存占位符**——`summary=''` + `summary_status='failed'` + **不生成 embedding**，等 cron 补处理 |
| **存活 ≠ 正确**（2026-09-25 教训） | 会话摘要在线上 **22 天 100% 失败**期间，容器 healthcheck 为 `healthy`、`/api/health` 全程 `{"status":"ok"}`。**存活指标（进程/端口/容器）不能替代正确性指标（摘要成功率/各模块 WARN 计数）**；判定"系统正常"必须引用后者 |
| **空转 ≠ 成功**（2026-09-26 教训） | `SessionEndProcessor.process()` 返回 `SessionEndResult{summarized, reason}`（`no-events`/`no-messages`/`no-dialogue`/`summary-failed`）；`archiveStaleSessions` 只在 `summarized` 时计入 `archived`，跳过/失败分别计数。⚠️ 原实现无条件 `archived++`——"提前 return 什么都没做"在日志里和"归档成功"完全一样（线上空转 18 小时无人发现） |
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
| 2026-08-14 | 内容自进化: worldbook/life 模板自写工具 + LLM 校验器(异常降级拒写) + 对话内删除(仅响应指令) + lookup_worldbook 实时化 + source 列 |
| 2026-06-28 | 初始设计，确认所有 7 节内容 |
| 2026-06-28 | 修正：编程模式改为注入精简画像（仅技术相关字段） |
| 2026-07-29 | v2 画像系统: ProfileFact 加 source/valid_from/valid_until/status 四字段; 冲突解决改为 supersede+审计链; 召回加状态过滤和置信度排序; 新增纠正快路径 (RealtimeProcessor); 新增隐私模式 (full/readonly/off); 新增记忆人格旋钮 (memory_config) 与 PersonaAdapter 联动 |

---

## ★ 8-28 运维工具：服务器数据同步（server-data-sync-script）

`packages/server/scripts/sync-from-server.sh`——手动脚本，把服务器（<SERVER_IP>，云端 appid
24h 在线，权威数据）的 alysia.db 全量同步到本地开发机：

1. 服务器容器内用 better-sqlite3 `backup()` **在线导出**（不停机，WAL 一致性安全）
2. scp 回本地 `packages/server/data/`
3. 本地旧库备份 `alysia.db.bak-<时间戳>`（可回滚）
4. 替换主库（清理残留 wal/shm）
5. 校验 `PRAGMA integrity_check` + 关键表计数
6. 本地 6185 服务在跑 → 中止（提示先停服务）

要点：Node 24 运行（better-sqlite3 ABI）；导出脚本需放入容器 `/app/packages/core/`（require 解析）；
触发方式为手动运行，不做定时。

**★ 9-25 凭据外置（fix-credential-leak-in-sync-script）**：
- 脚本**不得硬编码任何凭据**。2026-08-28 的提交 `05a2651` 曾把服务器 sudo 密码明文写在
  脚本第 11 行（`SUDO_PASS="${SUDO_PASS:-<明文>}"`），并随公开仓库暴露 28 天（8-28 ~ 9-25）。
  经核验该密码**同时是账号登录密码**（非独立 sudo 密码），危害链为
  「读公开仓库 → SSH 登录 → sudo root → 读 .env 与全库」；9-25 已在服务器侧轮换作废。
- 凭据来源优先级：环境变量 `SUDO_PASS` > `$HOME/.alysia-deploy-credentials` > 报错退出；
  `ALYSIA_CRED_FILE` 可改凭据文件路径
- 凭据文件**刻意放在仓库树之外**——树内文件离 `git add` 只有一步，gitignore 是「约定」不是「保证」
  （`docs/Docker-Deployment.md` 自身即 gitignored 却仍是树内文件，同理不可放凭据）
- 两者皆无 → **打印指引并 `exit 1`**，不回落默认值、不静默跳过（项目硬约束「不静默吞错」）
- 凭据只存于**仓库树外**的本机文件与密码管理器，**永不进仓库**
- 公开 git 历史**不改写**：密码已轮换 ⇒ 历史中留存的是死密码，改写收益为零而破坏所有既有克隆
- 本 change 的范围仅「凭据外置」；pre-commit 凭据扫描（治「敏感内容进公开仓库」的习惯问题）
  另开 change，不混在一起

**† 2026-10-15 迁移到新机（migrate-server-to-new-host）**：

服务已从旧机迁至新机（<SERVER_IP>，root + SSH 密钥免密）。同步脚本随之调整**两处**，
上面「★ 9-25 凭据外置」段的纪律**继续有效、不被推翻**：

- **† 契约 1：目标主机必须可配置，默认值可运行。**
  `SERVER="${ALYSIA_SERVER:-root@<SERVER_IP>}"`。硬编码主机是本次迁移暴露的直接缺陷
  （换一台机器就要改脚本正文）；留默认值是为了不动脑即可运行，留 env 覆盖是为了下一次迁移
  与本地对着别的实例调试。**被否决**：写进 `config.yml` —— 那份文件是部署产物，
  本机与服务器共用一份会互相污染（同类事故：`server-bind-host` 的 `host:` 字段）。

- **† 契约 2：凭据要求是条件式的 —— 远程为 root 时无需凭据。**
  脚本先探测远程真实身份：`REMOTE_UID="$(ssh "$SERVER" 'id -u')"`；
  `REMOTE_UID = 0` → `SUDO_PREFIX=""`（免凭据）；否则走上面的优先级链并置
  `SUDO_PREFIX="echo '$SUDO_PASS' | sudo -S "`。判断依据是**远程的真实身份**而非本机开关
  （开关会被忘记、会与实际不符，`id -u` 不会说谎）。
  前缀名取 `SUDO_PREFIX` 而非 `DOCKER_PREFIX`：实测 5 个调用点里有一个是 `sudo -S chown`
  （容器 → 宿主机取文件后的属主修正），不只 docker。

  ★ **这不是对「两者皆无 → exit 1」的削弱。** 该条款的**设计意图是「不许静默回落」**，
  不是「无论什么场景都必须有密码」。在 root 场景下「没有密码」是**正确状态**而非缺失 ——
  此时仍要求密码会让一个本可正常工作的情况被判死（这正是迁移前的实际故障形态）。
  因此原条款**原文保留**，仅把适用条件明确为「**远程非 root** 且两者皆无」。

- **† 契约 3：取代与新增是两件事。**
  本 change 只改目标主机与凭据模型（+ 部署 SOP 与 `.gitignore` 的仓库卫生，同属一次迁移收尾）。
  **旧机回收、凭据文件删除、LanceDB 瘦身都不夹带** —— 分别是旧机废弃、独立瘦身 change 的事。

**迁移事实（落地证据，供追溯）**：停机窗口约 2~3 分钟；`./data` 612M → 压缩 225M（剔除
`alysia.db.bak-*`）；旧机 → 新机直传约 11.6 MB/s；镜像 `save`/`load` 后 **15 层 digest 逐字节一致**
（`.Id` 差异仅因存储驱动不同：旧机 containerd snapshotter vs 新机 overlay2）；
`PRAGMA integrity_check` ok→ok；关键表计数（`ai_life_events` / `ai_life_daily_summaries` /
`ai_life_intents` / `conversations` / `worldbook_entries` / `life_templates` / `profile.facts`）
**逐项一致**；向量 2601→2602 行（+1 为迁移后新问候事件的向量，非丢失）；
模块 13/13 + 10/10；QQ 官方 `READY` 且**主动消息实发成功**（端到端证据）。
旧机保留为**回滚锚点**（数据原封不动），同机的 `astrbot` 容器全程未动。

**★ 8-28 分类容错（profile-extractor-category-fix）**：
- 根因：LLM 实测输出 location/interest/hobby 等自由词不遵循枚举 → 全回落 general（分类功能形同虚设）
- 修复：prompt 强约束（category 必须且只能从五个枚举值中选择，附中文语义）+ 提取器
  同义词容错映射（location/city→identity、interest/hobby/taste→preference、
  current/recent→status、friend/relation→relationship、未命中→transient 兼容兜底）
- 存量数据不重分类（需重新提取），新提取事实生效

**★ 8-29 Overlay 稳定演化（persona-overlay-perspective，HDSI Overlay 简化）**：
- 证据门槛：PersonaAdapter 同向调整 ≥3 次 → 固化 overlay 备注（persona.overlay_notes 新列）
  ——单次反馈不固化,达到证据门槛的稳定变化才"成为她现在的样子"
- 已固化参数豁免 24h 回归（稳定演化保留,不再拉回默认）
- PromptAssembler 注入【你的稳定变化】块（带证据）;getPersonaSnapshot 加 overlayNotes
