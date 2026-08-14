# Spec 变更: memory-system §2.6/§9 + ai-life-system §4/§14（内容自进化）

> apply 用——变更行用 `+` 标记，`-` 为删除。未列行与旧 spec 一致。
> 影响主 spec：`openspec/specs/memory-system/spec.md`、`openspec/specs/ai-life-system/spec.md`

## memory-system

### 2.6 Worldbook Store 表定义（加 source 列）

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
+   source          TEXT DEFAULT 'seed'     -- 条目来源: 'seed'(角色包导入/seed) | 'self'(昔涟自写)
);
```

（迁移：ALTER TABLE 带 PRAGMA table_info 存在性检查，存量行默认 'seed'。）

### 新增 2.8 内容自进化（2026-08-14，change: content-self-evolution）

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

### 9. 变更记录（追加一行）

| 2026-08-14 | 内容自进化: worldbook/life 模板自写工具 + LLM 校验器(异常降级拒写) + 对话内删除(仅响应指令) + lookup_worldbook 实时化 + source 列 |

## ai-life-system

### 4. 数据模型（新增 life_templates 表）

```sql
-- 生活模板池（通用模板 + 昔涟自进化新增；替代原 const/JSON 加载）
CREATE TABLE life_templates (
  id          TEXT PRIMARY KEY,
  activity    TEXT NOT NULL,          -- 活动描述
  type        TEXT NOT NULL DEFAULT 'internal',  -- 'chat' | 'internal'
  weight      INTEGER NOT NULL DEFAULT 2,        -- 加权随机权重；自加条目固定 2（防权重操纵）
  source      TEXT NOT NULL DEFAULT 'seed',      -- 'seed'(既有种子) | 'self'(昔涟自写)
  created_at  TEXT NOT NULL
);
```

### 14. 通用模板库（重写）

- ~~`packages/server/data/life-templates.json`（少量，无角色特色）~~ → 迁入 SQLite `life_templates` 表
  （2026-08-14，change: content-self-evolution）：
  - seed 8 条既有模板（source='seed'）启动时 INSERT OR IGNORE 保底（以 activity 判重）
  - 昔涟可通过 `add_life_template` 自加（source='self'，weight 固定 2）
  - `LifeService.pickTemplate()` 从 `memoryManager.listLifeTemplates()` 实时读取（weight 加权）；
    LLM 失败回落逻辑不变（模板事件强制 internal 防剧情链断裂）

（§5-13、§15-16 未列行与旧 spec 一致。）
