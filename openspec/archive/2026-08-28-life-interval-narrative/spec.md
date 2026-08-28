---
status: active
source: docs/superpowers/specs/2026-08-06-ai-life-system-design.md
migrated: 2026-08-07
---
# AI 主动生活系统 — 设计文档

> 日期: 2026-08-06  
> 状态: 已实现（2026-08-06）  
> 前置: ProactiveService（`packages/server/src/proactive.ts`）、sendProactive（`packages/server/src/adapters/qq-official.ts`）、EventStore、ProfileStore、WorldbookStore

> ★ 8-27 叙事化重构（change: life-system-narrative-refactor，参考 HDS-Interlude）：
> 配角在场（ScenePresence）/ 情绪惯性（mood_value）/ 模板扩容分类 / 世界书分层随机 /
> daily_life.md / 9 条生成约束 / 7 条 post-check / Agency Window（can_contact）/ 对话余波。
> 核心理念：事件从角色的生活中自然生长，而非模板堆砌。

---

## 1. 背景与目标

当前 AI 助手只能被动响应，用户不开口它就沉默，缺乏"生活感"与陪伴感。

**目标**：让 AI 拥有独立的日常事件流，能够主动发起对话、分享自己的"生活"，形成自然的双向陪伴关系。

**核心设计原则**（源自需求文档 v0.1）：

1. **AI 有自己的生活**——不是等用户来聊，而是有自己的日常事件、状态和情绪
2. **主提示词瘦身**——只奠定角色基调，细节由角色画像动态注入（**二期独立做**，本次不动对话主链路）
3. **用户只给框架，内核由 AI 驱动**——事件如何发生、何时开口，由 AI 自主决策

---

## 2. 关键决策（已确认）

| 决策点 | 结论 |
|--------|------|
| 事件库 | 世界书人设背景（采样注入）+ 通用模板 + LLM 自创 |
| 事件驱动调度（8-09） | 概率门移除；LLM `next_in_hours` 建议间隔（0.5-8h 钳制，沉浸/想聊可变） |
| 主动聊天冷却 | ≥1 小时（8-09 从 2h 缩短）+ 每日 chat 软上限 5 条 |
| 聊天锁 | 30 分钟内有用户互动 → 跳过本轮并顺延重排 |
| 窗口外事件 | 照常生成（生活积累），窗口内尝试推送 |
| 事件时间感知 | 生成器/事件流注入/判定器全部注入当前本地时间 |
| 事件连续性 | 事件可引用历史事件（剧情链），每日摘要生成 |
| 事件存储分层 | 原始事件全量存；注入/引用分层（今天逐条+近7天摘要） |
| 亲密度 | 互动数据自动推导 0-100 |
| 主动消息回写 | 推送成功的消息 ingest 回 EventStore（assistant 角色） |
| 主动消息表情包 | 本次支持（扩展 sendProactive 解析 `[表情包:xxx]`） |
| 主提示词瘦身 | 二期独立立项 |
| 事件注入 prompt | 每次对话注入「[我的近期日常]」块 |
| 配角在场（8-27） | 新表 `ai_life_scene_presence`；事件提到谁 → present，24h 无提及 → off-scene；生成注入【在场角色】，LLM 不得召唤离场角色（HDSI ScenePresence 简化：不做 LLM 更新回路，自动推导） |
| 情绪惯性（8-27） | `ai_life_state.mood_value` 累积（同向加成/反向衰减/8h 回归 0）；注入【心情】块影响事件风格（HDSI Alter 简化：mood_value 本身即 prompt 可见，不做侧端分析） |
| Agency Window（8-27） | 事件 JSON 带 `agency.can_contact`；推送判定加"方便联系"条件（HDSI 简化：不做重查队列） |
| 对话余波（8-27） | 最后 user 消息 15min 后无 followup 事件 → 生成 internal 余波（origin='followup'，不推送只记录） |

---

## 3. 架构

```
LifeService（新建，每小时 tick，与 ProactiveService 并存）
│
├── ① 事件判定器（决策门，全过才触发）
│      概率 30% → 冷却 ≥2h → 聊天锁（30min 内有互动→跳过）
│      → 深夜(0-7点)强制 type=internal
│
├── ② 事件生成器（LLM，woke 模式）
│      输入: [当前时间] + 当前状态 + 事件回顾(今日逐条+近7天日摘要)
│            + 世界书人设背景(采样N条) + 用户画像 + 亲密度 + 通用模板参考
│      输出: { content, type('chat'|'internal'), mood_delta, reference_event_id? }
│
├── ③ AI 状态机（持久化）
│      current_activity / mood / intimacy（每日摘要独立存摘要表）
│
├── ④ 事件流存储（SQLite 新表 ai_life_events，完整历史）
│
├── ⑤ 亲密度引擎（每小时更新）
│      EventStore 近7天互动频率 / 会话时长 / 用户主动占比 → 0-100
│
└── ⑥ 推送与回写
      chat 事件 + 窗口内 → sendProactive(带表情包解析)
      → 成功后 ingest 回 EventStore（assistant 角色，记忆线完整）
      窗口外 / internal → 只更新状态（生活积累，二期补叙）
```

### 与现有系统关系

- **ProactiveService**（问候/节日/关怀）保持不动，两服务并存
- **WorldbookStore**：作为人设背景约束注入事件生成器
- **复用**：tick 机制、去重持久化模式、`sendProactive`、LLM 决策 + 失败回落、ProfileStore、EventStore、WorldbookStore
- **改造点**：PromptAssembler 事件流注入、sendProactive 表情包解析、EventStore 回写

---

## 4. 数据模型（SQLite 新增）

```sql
-- AI 侧实时状态（单行）
CREATE TABLE ai_life_state (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  current_activity TEXT,        -- 此刻在做什么（如 "在阳台看书"）
  mood            TEXT,         -- 心情（由事件驱动变化，如 "平静/开心/困"）
  intimacy        INTEGER DEFAULT 30,  -- 亲密度 0-100
  last_event_id   TEXT,
  updated_at      TEXT
);
-- ★ 8-27 情绪惯性（migration: ALTER TABLE + try-catch）
--   mood_value: 情绪累积值 -100..100（同方向加成/反方向衰减/8h 回归 0），
--   极性注入【心情】块影响事件风格；正=开心/负=低落，0=平静
-- ALTER TABLE ai_life_state ADD COLUMN mood_value INTEGER DEFAULT 0;

-- 事件流（完整历史，供连续性/回顾/注入）
CREATE TABLE ai_life_events (
  id              TEXT PRIMARY KEY,
  created_at      TEXT,         -- 事件发生时间（本地时间）
  type            TEXT,         -- 'chat'(可推送) | 'internal'(仅状态)
  content         TEXT,         -- 事件描述
  mood_delta      TEXT,         -- 心情变化（可空）
  reference_event_id TEXT,      -- 引用的历史事件（剧情链，可空）
  wb_entry_id     TEXT,         -- 关联的世界书条目（可空）
  delivered       INTEGER DEFAULT 0   -- 是否已推送给用户
);
-- ★ 8-27 对话余波标记（migration: ALTER TABLE + try-catch）
--   origin: 'regular'(常规事件) | 'followup'(对话余波)——余波事件不推送只记录
-- ALTER TABLE ai_life_events ADD COLUMN origin TEXT DEFAULT 'regular';

-- ★ 8-27 配角在场状态（新表；HDSI ScenePresence 简化版）
--   present=在场 | off-scene=离场 | expected=待会合；事件内容提到谁 → present，
--   24h 无提及 → off-scene。仅记录已确认在场的配角（角色世界书里的人物）。
CREATE TABLE IF NOT EXISTS ai_life_scene_presence (
  name        TEXT PRIMARY KEY,       -- 配角名（如 迷迷/风堇/遐蝶/白厄）
  status      TEXT NOT NULL DEFAULT 'off-scene',  -- present | off-scene | expected
  basis       TEXT,                   -- 在场依据（最近一次提到的事件内容摘要）
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_life_events_time ON ai_life_events(created_at);

-- 每日生活摘要（分层注入用；原始事件全量保留在 ai_life_events）
CREATE TABLE ai_life_daily_summaries (
  date            TEXT PRIMARY KEY,  -- 日期 'YYYY-MM-DD'（本地时间）
  summary         TEXT,              -- 当日生活摘要（LLM 生成）
  created_at      TEXT
);

-- ★ 8-14 生活模板池（content-self-evolution）：替代原 const/JSON 加载
CREATE TABLE life_templates (
  id          TEXT PRIMARY KEY,
  activity    TEXT NOT NULL,          -- 活动描述
  type        TEXT NOT NULL DEFAULT 'internal',  -- 'chat' | 'internal'
  weight      INTEGER NOT NULL DEFAULT 2,        -- 加权随机权重；自加条目固定 2（防权重操纵）
  source      TEXT NOT NULL DEFAULT 'seed',      -- 'seed'(既有种子) | 'self'(昔涟自写)
  created_at  TEXT NOT NULL
);
-- ★ 8-27 模板分类分组（migration: ALTER TABLE + try-catch）
--   category: '独处' | '互动' | '分享'——回落模板按场景分类
--   group_name: 'none' | '迷迷' | '风堇' | '遐蝶' | '白厄' | '其他人'——按角色关系分组
-- ALTER TABLE life_templates ADD COLUMN category TEXT DEFAULT '独处';
-- ALTER TABLE life_templates ADD COLUMN group_name TEXT DEFAULT 'none';
```

---

## 5. 事件判定器（8-09 起：事件驱动调度，替代每小时 tick + 概率门）

```
启动 → scheduleNextEvent(): 用持久化 nextEventAt；已过/缺失 → 重排 now + 默认2h(±30min抖动)
      ↓ 到点
tick() {
  if (最近30分钟有用户互动) return;            // 聊天锁（顺延重排下一次）
  const deepNight = now.hour 在 0-7;

  const event = await 事件生成器(deepNight);    // LLM，带回 next_in_hours / continuation_of
  存入 ai_life_events;

  // ★ 8-27 Agency Window：推送门加"方便联系"条件（can_contact 来自事件 JSON，
  //   反映角色当前活动/心情/环境是否适合联系轻月——如沉浸中/心情低落不想说话 → false）
  if (event.type === 'chat' && !deepNight && 冷却通过 && 未超日上限 && event.can_contact !== false) {
    const ok = await sendProactive(ownerOpenid, event.content);  // 长文案自动分段
    if (ok) { delivered = 1; 回写EventStore; }
  }
  // can_contact === false → 降级 internal 入库不推送（生活积累，等下一次事件）
  // 冷却中 / 超日上限 → chat 降级 internal（照常入库不推送）
  // 窗口外/deepNight：积累，等补叙（二期）

  nextEventAt = now + clamp(LLM 建议 next_in_hours, 0.5h, 8h);  // 未建议 → 默认2h抖动
  持久化 state.json; scheduleNextEvent();
}
```

**8-09 变更**（change: ai-life-event-driven-scheduling）：
- 概率门（30%）**移除**——触发时机的不确定性由 LLM `next_in_hours` 建议承担（事件内容
  决定时间："玩游戏"→ 沉浸 3h 后再来）
- `next_in_hours`（0.5-8h 钳制）与 `continuation_of`（延续【你正在做的事】）进事件 schema
- 重启**重排不补发**（nextEventAt 已过 → 默认间隔重排，错过即错过）
- chat 推送冷却 2h → **1h**；新增**每日 chat 软上限**（默认 5 条，超限降级 internal）
- 聊天锁命中 → 重置沉浸（不注入延续块）+ 顺延重排

**聊天锁实现**：`EventStore.getRecentBySession(umo, 1, new Date(Date.now()-30min))` 有记录 → 跳过。

**对话余波**（8-27，HDSI conversation-follow-up 简化）：最后一条 user 消息过去 15min 后，
若无 followup 事件（`origin='followup'`）且不在深夜 → 生成 internal"对话余波"事件：
注入最近对话上下文，LLM 生成"聊完后的自然反应"（如"想到刚才说的话，有点不好意思"）。
只入库不推送（origin='followup'，Web 端不显示推送标签）。余波事件同样回写记忆、参与 mood_value 累积。

**深夜抑制**：0-7 点事件仍生成但 `type` 强制 `internal`（生活积累不打扰）。

**延续机制**：最近 8h 内 internal 事件 + 30min 无用户互动 → 注入【你正在做的事】块，
LLM 可选 `continuation_of`（防幻觉：须命中今天事件 ID 集合）。

**长文案分段发送**（sendProactive）：>60 字自动按标点分段（≤40 字/段、段间 500-900ms、
任一段失败立即中断、≤3 段超出合并）——模拟实时打字节奏；prompt 约束句号自然断句。

---

## 6. 事件生成器（LLM，woke 模式）

参考 AstrBot 的 `PROACTIVE_AGENT_CRON_WOKE_SYSTEM_PROMPT` 设计——明确告知 LLM 这是定时唤醒而非用户消息。

**系统提示词骨架**：

```
你是昔涟，此刻你正过着独属于自己的生活。

【当前时间】2026年8月6日 星期四 21:35
【当前状态】你正在: 在阳台看书；心情: 平静
【亲密度】与轻月: 62/100
+【心情】情绪累积: +8（最近心情偏开心）——事件风格贴合当前情绪

【今天的生活】
- 09:30 在阳台看书，看到一朵像兔子的云
- 15:00 听到楼下琴声，有点想学

【最近的生活】（近 7 天日摘要，今天除外）
- 昨天: 在旧书店待了一下午，淘到一本讲星星的书
- 前天: 下雨，在窗边听了很久的雨

【你的人设背景】（★ 内容 = 激活角色世界书采样，以当前 persona/世界书文件为准，此处仅为示意）
- （世界书条目 1 摘要）
- （世界书条目 2 摘要）
- ...

+【在场角色】（★ 只有这些配角此刻在你身边/可互动；列表为空就是独处，不要凭空召唤他人）
+- 迷迷（在你身边蹭来蹭去）
+- 风堇（在昏光庭院忙，偶尔路过）
+【轻月最近】用户最近在忙什么（ProfileStore facts 摘要，可空）

你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。
请生成一个此刻可能发生在你身上的生活事件（1-2 句话，第一人称）。
要求:
- 贴合当前时间线（晚上不晨跑，深夜安静地看书/发呆）
- 符合你的人设背景，可以从上面取材，但不要生硬引用
- 可以引用今天/昨天的事件形成剧情（如"这让我想起..."），不要每件事都引用
- 如果和轻月聊得来（亲密度高），可以生成想分享给他/她的内容
- ★ 8-27 生活真实感约束（9 条）：
  1) 活动范围：事件发生场景须在你生活的场所内（住所/常去的角落），不超出生活半径
  2) 生活气息：要有具体的生活细节（物件/声音/光/气味），拒绝抽象概括
  3) 不是一个人：生活里有【在场角色】可以自然交集；但没列出的配角一律不出现
  4) 不硬复述设定：世界书背景融入行为习惯即可，不要生硬罗列设定词条
  5) chat 是分享不是报备：对轻月说话是分享此刻的心情/趣事，不是汇报日程
  6) 不引用对话：不要复述/引用与轻月的对话内容（对话是记忆，不是生活素材）
  7) 注意当前心情：事件的情绪色彩贴合【心情】块的累积情绪
  8) 时间线贴合（晚上不晨跑，深夜安静）
  9) 第一人称，1-2 句，句号自然断句（按句分段推送）
- ★ 8-27 Agency：若想找轻月聊天但此刻不方便（沉浸中/情绪低落/环境不适合）→ type=internal + can_contact=false
- 只输出 JSON: {"content": "...", "type": "chat|internal", "mood_delta": "...", "mood_shift": 1, "reference_event_id": "...", "wb_entry_id": "...", "agency": {"can_contact": true, "reason": "..."}, "next_in_hours": 2.5}
```

**mood_shift**（8-27）：-5..+5 整数，本轮事件对情绪的净变化（开心事件给正、低落给负、平静给 0）。非法值忽略按 0 处理。

**post-check 7 条**（8-27，生成后规则校验，任一不过 → 带反馈重试 1 次 → 仍不过回落模板）：
| # | 校验 | 规则 |
|---|------|------|
| 1 | 长度 | content ≤ 80 字（超长截断/拒绝） |
| 2 | 不硬设定 | 不含"作为黄金裔/火种/岁月"等设定词条生硬罗列（黑名单词） |
| 3 | 对话感 | chat 事件以分享语气开头（无则按分享重写） |
| 4 | 不重复 | 与今天已有事件 content 去重（完全相同/前 12 字相同 → 拒绝） |
| 5 | 不连续独处 | 已有连续 ≥3 个 internal 事件且本事件仍 internal → 提示倾向互动 |
| 6 | 不引用对话 | content 不含引号包裹的直接引用（"你说…"/"你刚才…"） |
| 7 | 不在场角色不出现 | content 中出现的配角名必须在【在场角色】列表内 |

**世界书采样**：激活角色 worldbook 条目中采样 N=5 条（priority 加权 + cooldown 过滤），作为「人设背景」。被事件引用的条目 `hit_count+1` 并记录 `wb_entry_id`。

**失败回落**：LLM 失败 → 从通用模板池随机取一条（`data/life-templates.json`），`type=internal`
（8-09 修复：原实现回落 `t.type` 可能为 chat 导致模板推送、剧情链断裂——模板强制 internal 只入库不推送）。

**事件回写**（8-09 C，change: proactive-memory-closure）：所有事件（chat 推送成功的 +
internal）都回写 EventLog（assistant 角色）——bot 记得自己在做什么；internal 不进推送
但进记忆。

**事件生成上下文**（8-09 B）：generateEvent prompt 注入【最近对话】块
（getRecentDialogueBlock，24h/40 条）——事件生成贴合最近聊了什么。

**裸文本容错**（8-09，change: life-bare-text-event-tolerance）：LLM 偶发输出无 JSON 外壳的
自然语言（8-09 07:16 实测：高质量剧情文本被 JSON.parse 丢弃 → fallback 模板推送）。
JSON 解析失败但文本非空 → 直接作为事件 content，type 与 JSON 路径同规则
（`deepNight ? internal : chat`）——不丢高质量输出。空响应/抛异常仍走模板回落。

**json mode 治本**（8-09，change: life-event-json-response-format）：generateEvent 调用
带 `responseFormat: 'json'` → 请求体注入 `response_format: {"type": "json_object"}`
（DeepSeek json mode）——模型层面强制输出合法 JSON（根治裸文本）。约束：
systemPrompt 必须含 "json" 字样；json mode 与 funcTool 互斥；仅非流式调用生效。
应用层容错（fence 剥离 + 裸文本兜底）保留作双保险。

---

## 7. 世界书关联（人设背景约束）

实际探索确认：世界书 66 条是**静态 lore**（关键词触发注入的设定/回忆），不是时间性事件。定位修正：

```
worldbook_entries（激活角色的实际设定内容，如人设/回忆/情境）
│
├── ① 人设背景注入：事件生成器采样 N=5 条 → 「你的人设背景」块
│      ★ 内容以当前激活角色世界书为准（切角色事件风格跟随）
+│      ★ 8-27 分层随机（life-worldbook-layered-sample）：content_type='life_event' 随机取 3
+│        + content_type='text' 随机取 2（ORDER BY RANDOM()，不再按 priority 排序），
+│        每条截断 200 字（原 100 字）——角色生活化条目优先于设定条目
+│      ★ 8-27 digest 简介优先（worldbook-digest-summary）：text 条目由 LLM 生成
+│        120-150 字「角色简介」（digest 列：核心设定 + 与昔涟的关系 + 对生活的意义），
+│        采样注入时 content 字段 = digest ?? 截断正文（无 digest 兜底 200 字）。
+│        life_event（天然 ≤154 字）/ image（表情包）不生成 digest。
+│        生成方式：一次性脚本 scripts/digest-worldbook.ts 批量生成（幂等可重跑，
+│        只处理无 digest 的条目；失败跳过计数）——66 条 text 全量生成后注入质量
+│        不受截断影响（白厄 974 字 → 简介保留发小关系核心）
│
├── ② 命中统计：事件引用条目 → hit_count+1，与对话触发共用冷却
│
└── ③ 角色隔离：按当前激活角色过滤
```

**通用模板定位**：`life-templates.json` 只保留无角色特色的日常（倒水/发呆/听歌/整理房间），角色特色事件由 LLM 结合世界书背景自创。

---

## 8. 事件连续性（剧情链）与存储分层

**存储**：原始事件全量保留在 `ai_life_events`（450 条/90 天仅几百 KB，SQLite 无压力），不删除。

**注入/引用分层**（瓶颈在 prompt 大小，不在存储）：

| 层 | 内容 | 用途 |
|----|------|------|
| 活跃层 | 今天的事件逐条 | 对话注入、事件生成回顾 |
| 摘要层 | 近 7 天日摘要（`ai_life_daily_summaries`） | 对话注入、事件生成回顾 |
| 记忆层 | 7 天前的日摘要（保留 90 天） | AI 可记得"两周前的旧书店"（通过摘要） |

- **每日摘要生成**：每天 0 点（tick 检测跨天），LLM 把昨日事件压缩成一条日摘要存入 `ai_life_daily_summaries`
- **剧情链引用**：`reference_event_id` 只允许引用**今天的事件**（生成器注入时事件带 `[id: life-xxx]`，LLM 返回的 id 必须命中今天事件 ID 集合才入库，防幻觉；近 7 天摘要行不带 ID，仅作回顾不可引用）。原始设计意图允许引用 7 天内事件 + 摘要引用，因防幻觉收窄为今天范围——扩展留二期（窗口外事件补叙）
- **效果**：AI 的生活连贯——今天的事能关联昨天，两周前的旧书店也记得（通过摘要），不会"今天做了明天就忘"

---

## 9. 时间注入

| 位置 | 注入内容 | 说明 |
|------|---------|------|
| 对话 prompt | `[当前时间]`（已实现于 llm-agent.ts） | AI 答"今天几号"、感知早晚 |
| 事件生成器 | `[当前时间]` + 当前状态/心情 | 事件贴合时间线 |
| 事件流注入 prompt | 每条事件带时间戳 | 引用时时间线清晰 |
| 每日摘要生成 | 每日 0 点（tick 检测跨天），LLM 压缩昨日事件 | 摘要层/记忆层数据源 |

时间格式统一：`2026年8月6日 星期四 21:35`（本地时间）。

---

## 10. 事件流注入 prompt（PromptAssembler 改造）

每次对话组装 system prompt 时追加：

```
[我的近期日常]
- 今天 09:30 在阳台看书，看到一朵像兔子的云
- 今天 15:00 听到楼下琴声，有点想学
- 昨天: 在旧书店待了一下午，淘到一本讲星星的书
- 前天: 下雨，在窗边听了很久的雨
- （被引用链上的关联事件 + 命中的世界书条目）
```

**注入规则**：今天的事件逐条 + 近 7 天日摘要（每条一行）。7 天前的摘要不注入（太远，只在 AI 主动回忆时通过摘要检索）。

实现：`MemoryManager.getLifeEventInjection(limit)` → PromptAssembler `assembleChat` 注入。受隐私模式控制（readonly/full 不注入）。事件为空时不加块。

---

## 11. 亲密度引擎

每小时更新一次（事件 tick 时顺带），数据全部来自 EventStore（近 7 天最多 500 条消息）：

```
intimacy = clamp(30 + 频率分 + 时长分 + 主动分, 10, 100)，经 confirmation_bias 平滑
```

- **频率分**：`min(35, 加权消息数/4×5)`。加权消息数按 `recency_weight` 加权：
  近 3 天消息 ×(1+w)，更早 ×max(0.1, 1−w×0.5)（默认 0.3 → 近期 1.3 权重）
- **时长分**：`min(21, n>20 ? 21 : n×1.05)`（消息数代理会话时长，默认值下 40 条封顶）
- **主动分**：`min(14, 用户消息首条数×3)`（连续 user 消息只计一条，近似主动发起率）
- **衰减**：`decay_rate` 驱动——每日衰减 = `decay_rate×6`（默认 0.3→1.8/天），
  衰减阈值 = `2 + (1−importance_threshold)×10` 天（默认 0.4→8 天；只记大事→2 天，什么都记→12 天），
  超过阈值每天 `−decayPerDay×(idleDays−threshold+1)`，只作用于频率分，下限 10
- **平滑**：`confirmation_bias`——新值 = 旧值 + (计算值−旧值)×(1−c×0.7)（固执→变化小，防跳变；默认 0.3）
- 初始 30；旋钮均读 `persona.memory_config`（2026-08-07 接线，change: wire-memory-config-knobs）

**用途**：注入事件生成器（影响语气/分享意愿）；二期主提示词动态注入。

> 注：原始设计（天数×5 / 会话时长 / 首条占比 + 固定 3 天 -2 衰减）在实现时改为上述消息数近似 +
> 旋钮驱动版本（review 修复：原公式时长分封顶达不到 21）。实现为准，本 spec 已对齐。

---

## 12. 主动消息回写记忆（关键）

AI 主动推送的内容必须回写 EventStore，否则用户回复时 AI 不记得自己说过什么：

```ts
// 推送成功后
await memoryManager.ingest({
  id: `life-${Date.now()}`,
  session_id: `qq-official-1:private:private_${openid}`,
  source: 'chat',
  type: 'message',
  payload: { content: event.content, role: 'assistant' },
  importance: 0.3,
  created_at: new Date().toISOString(),
  processed: 0,
});
```

- EventStore 按 `payload.role` / `sender_id` 区分 user/assistant（无 sender_id = assistant）
- 用户回复主动消息时，`getRecentBySession` 能读到完整对话
- 注意：ingest 会触发 RealtimeProcessor（世界书匹配/人格扫描）——符合预期

---

## 13. 主动消息表情包支持

`sendProactive` 扩展：发送前跑 `parseStickerMarks` + `stickerResolver` + 私聊直发图片（`srv_send_msg=true` 路径已有，实测可用）。

- 事件内容带 `[表情包:嘻嘻]` → 文本+图片分离发送
- 解析失败/找不到 → 静默去标记，只发文本
- 群聊主动消息不解析（受限，当前只有私聊场景）

---

## 14. 通用模板库

**★ 8-14（change: content-self-evolution）迁入 SQLite `life_templates` 表**（替代原
`packages/server/life-templates.ts` const / `data/life-templates.json`）：

- seed 8 条既有模板（source='seed'）启动时 INSERT OR IGNORE 保底（以 id 幂等——用户删过的种子重启不复活）
- 昔涟可通过 `add_life_template` 自加（source='self'，weight 固定 2，type 参数化）
- ★ 8-27 自加分类（life-template-self-classify）：工具参数加 `category`（独处/互动/分享）+
  `group_name`（none/迷迷/风堇/遐蝶/白厄/其他人），LLM 自行判断——活动涉及在场角色 →
  互动+对应角色组；想分享给轻月 → 分享；否则独处。未传时默认映射（chat→分享、
  internal→独处）——自写模板回落时能正确匹配在场角色组
- `LifeService.pickTemplate()` 从 `memoryManager.listLifeTemplates()` 实时读取（weight 加权）；
  LLM 失败回落逻辑不变（模板事件强制 internal 防剧情链断裂）
- ★ 8-27 扩容 40+ 条（life-template-expansion）：8 条 → 40+ 条，按 `category` 分三类：
  独处 ~20（发呆/家务/看书/听歌）+ 互动 ~12（与在场配角的小交集）+ 分享 ~12（想对轻月说的话）；
  按 `group_name` 按角色关系分组（none/迷迷/风堇/遐蝶/白厄/其他人）——分组用于回落时
  尽量选与"在场角色"匹配的模板（在场无迷迷 → 不回落"迷迷"组模板）
- 回落优先级：在场角色组模板 → 独处模板；仍以 LLM 生成为主路径，模板只是保底

---

## 15. 分阶段

**本次（一期，完整实现）**：
- [x] ai_life_state / ai_life_events / ai_life_daily_summaries 表
- [x] LifeService（判定器 + 生成器 + 状态机 + 亲密度 + 每日摘要生成）
- [x] 事件存储分层（全量存 + 摘要层 + 剧情链引用）
- [x] 世界书背景采样注入 + 命中统计
- [x] 通用模板库 `data/life-templates.json`
- [x] 主动消息回写 EventStore（assistant 角色）
- [x] sendProactive 表情包解析扩展
- [x] 事件流注入 PromptAssembler（今天逐条 + 近 7 天摘要）
- [x] bootstrap 接线（与 ProactiveService 并存）
- [x] 测试

**二期（独立立项）**：
- [x] 主提示词瘦身（8-12：今天事件 top3 注入 + 500 字预算，细节走向量检索）
- [x] 窗口外事件补叙（8-12：昨天 internal 最近 2 条注入）
- [x] 事件向量检索（8-12：recordLifeEvent 嵌入 source=life_event，read() 纳入召回）
- [x] 世界书 life_event 种子（8-12：getWorldbookSample 纳入，priority 同池采样）
- [x] 亲密度 API 就绪（/api/life 返回 intimacy）；UI 渲染待 Web 端整体开工

**8-27 叙事化重构（life-system-narrative-refactor）**：
- [x] 配角在场：ai_life_scene_presence 表 + 事件内容推导（提到谁 → present，24h 无提及 → off-scene）+ 生成注入【在场角色】+ post-check ⑦
- [x] 情绪惯性：ai_life_state.mood_value（同向加成/反向衰减/8h 回归 0）+【心情】注入
- [x] 模板扩容 40+ 条（category 独处/互动/分享 + group_name 角色分组）
- [x] 世界书分层随机（life_event 3 + text 2，随机抽取，截断 200 字）
- [x] daily_life.md（10-15 条 content_type='life_event'：住所/饮食/爱好/习惯/童年）+ loader 纳入
- [x] 9 条生成约束 + 7 条 post-check（重试 1 次 → 回落模板）
- [x] Agency Window：事件 JSON agency.can_contact → 推送门加"方便联系"条件
- [x] 对话余波：最后 user 消息 15min 后生成 internal 余波（origin='followup'，不推送）

**8-27 世界书 digest 简介（worldbook-digest-summary）**：
- [ ] worldbook_entries.digest 列（ALTER + try-catch）+ getWorldbookSample 优先 digest（无 digest 回落截断 200）
- [ ] scripts/digest-worldbook.ts 批量生成（幂等可重跑，只处理无 digest 的 text 条目）
- [ ] 66 条 text 全量生成完成并抽查质量

---

## 16. 测试计划

- 单元：判定器概率门/冷却/聊天锁/深夜抑制（注入时钟）
- 单元：时间注入格式
- 单元：亲密度推导公式
- 单元：世界书采样权重/cooldown 过滤
- 单元：事件回写 MemoryEvent 构造
- 集成：事件生成 LLM mock → 状态更新/事件入库/回写 EventStore
- 集成：事件流注入 prompt 组装（含隐私模式）
- 集成：sendProactive 表情包解析（mock resolver）
- E2E（可选）：真实 LLM 生成一次事件

**★ 8-28 意图系统（ai-life-intent-system，参考 HDSI intent 表）**：
- `ai_life_intents` 表：角色自己的隐式意图（与 reminders 用户显式提醒并列）。
  type: delayed-reply(想想再答复) | promise(承诺到期兑现) | proactive-contact(主动联系候选)
- 产生来源双通道：
  ① 事件生成（life.ts）：LLM 事件 JSON 带 `intent` 字段（can_contact=false 时存，
     delay_hours 1-72 钳制后重查推送）——"想告诉轻月但正在忙"不丢弃
  ② 对话 POST 解析（llm-agent.ts）：`[intent:类型|内容|延迟小时数]` 标记（与 [表情包:xxx]
     同模式，不走工具调用——隐式意愿 LLM 不会主动调工具），解析后剥离用户不可见
- 到期处理（LifeService.tick 扫描）：proactive-contact 直接推送；delayed-reply/promise
  用 generateIntentMessage 回调生成自然兑现消息 → sendProactive；成功 completed 防重复，
  失败保留 pending 下次再查
- MemoryManager：saveIntent / listDueIntents / completeIntent / cancelIntent

**★ 8-28 生活微叙事（life-event-micro-narrative）**：
- 事件从"1-2 句快照"→"2-4 句生活切片"：具体时辰、平凡物件、伴随小动作、小意外转折，
  前因后果自然流动（"因为…才想起…"）；prompt 加【生活切片示范】块（"人时物"平实风格），
  拒绝纯文学意象堆砌
- 延续主路径：有【你正在做的事】→ 优先续写推进（进展/波折/完成），自然收尾才开新
- 深夜抑制关闭：deepNight 不再强制 internal——类型交 LLM，深夜只是安静的时辰提示，
  推送门去掉深夜条件
- post-check：长度 ≤80 → ≤150；重复检测前 12 字 → 前 20 字
- 注入预算：今天 3 条 → 2 条、每条截断 100 字；每日摘要 30 字 → 50 字
**★ 8-28 承诺闭环（promise-obligation-loop）**：
- 到期三选一裁决（delayed-reply/promise 统一）：fulfill 兑现推送 / defer 延期重排
  （推送延期说明，defer_count 上限 2 次，超限强制兑现）/ cancel 取消（推送歉意说明，不静默）
- evidence 列：解析时备份承诺原句（[intent:] 标记所在句），裁决 prompt 带原文还原语气
- 裁决回调：generateIntentMessage 升级为 JSON 输出 {action, content, delay_hours?}
  ——prompt 带承诺原文/内容/当前状态/已延期次数
