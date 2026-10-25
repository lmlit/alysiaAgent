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
| 锁续期（8-30, life-schedule-renewal） | 每次触发=锁续期：成功按模型建议(0.5-8h)/失败 1h 保底/异常 try-catch 兜底——锁一定续，永不静默停摆（P1-6）。★ **2026-10-20 澄清**：P1-6 防的是**生产故障**（LLM 炸了/锁断了/进程停了），**不防「她主观上不想开口」** —— 她可以拒绝，但拒绝路径**照样续期锁 + 留理由**，见 §11.2 |
| 时段保底（8-30） | 模型缺失/失败时：白天(7-24h) 1h / 夜间(0-7h) 2h——睡觉节奏放慢；模型给值始终优先（想聊可提前、沉浸可延长） |
| 主动聊天冷却 | ≥1 小时（8-09 从 2h 缩短）+ 每日 chat 软上限 5 → **20**（8-30：实测问候 3 条/天零错误码，QQ 配额无忧；打扰由冷却+上限+时段保底控制） |
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
| **亲密度 → 推送闸（2026-10-20）** | 四档（≥70/40/25/<25）按亲密度压低每日上限与冷却，**只降不升**；`idleDays` 只认真人 user 消息（排除 `skip_profile`/`synthetic` 注入）；升档迟滞 +5；见 §11.1（change: `tie-intimacy-to-speech`） |

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
启动 → scheduleNextEvent(): 用持久化 nextEventAt；已过/缺失 → 重排 now + 默认1h(±30min抖动)
      ↓ 到点
tick() {
  if (最近30分钟有用户互动) { 顺延重排; return; }   // 聊天锁
  const deepNight = now.hour 在 0-7;

  const event = await 事件生成器(deepNight);    // LLM，带回 next_in_hours / continuation_of
  if (!event) {                                  // ★ 8-30 锁续期(P1-6)：失败也续期,不停摆
    nextEventAt = now + 时段保底(白天1h/夜间2h); 持久化; scheduleNextEvent(); return;
  }
  存入 ai_life_events;

  // ★ 8-27 Agency Window：推送门加"方便联系"条件（can_contact 来自事件 JSON）
  if (event.type === 'chat' && 冷却通过 && 未超日上限 && event.can_contact !== false) {
    const ok = await sendProactive(ownerOpenid, event.message ?? event.content);  // 8-29 推送 message
    if (ok) { delivered = 1; 回写EventStore; }
  }
  // can_contact === false → intent 落库(delay 后重查)或降级 internal 入库不推送
  // 冷却中 / 超日上限 → chat 降级 internal（照常入库不推送）

  nextEventAt = now + intervalMs(event);         // ★ 8-30 锁续期：模型建议 0.5-8h 钳制;缺失 → 时段保底
  持久化 state.json; scheduleNextEvent();        // 异常时 setTimeout 回调 catch 兜底续期
}
```

**8-09 变更**（change: ai-life-event-driven-scheduling）：
- 概率门（30%）**移除**——触发时机的不确定性由 LLM `next_in_hours` 建议承担（事件内容
  决定时间："玩游戏"→ 沉浸 3h 后再来）
- `next_in_hours`（0.5-8h 钳制）与 `continuation_of`（延续【你正在做的事】）进事件 schema
- 重启**重排不补发**（nextEventAt 已过 → 默认间隔重排，错过即错过）
- chat 推送冷却 2h → **1h**；新增**每日 chat 软上限**（默认 5 条，超限降级 internal）
- 聊天锁命中 → 重置沉浸（不注入延续块）+ 顺延重排

**8-30 锁续期**（change: life-schedule-renewal，实证：服务器 33h 停摆 = P1-6 bug 真实发生）：
- **锁一定续**：成功按模型建议(0.5-8h)；生成失败(LLM+模板全空) → 时段保底续期；
  tick 抛异常 → setTimeout 回调 catch 后兜底续期——不再静默停摆
- **时段保底**：白天(7-24h) 1h / 夜间(0-7h) 2h——她睡觉/安静的夜节奏放慢，
  减少编造夜间活动；模型给值始终优先（想聊给 0.5h → 深夜也能提前聊）
- **每日 chat 软上限 5 → 20**（8-30：实测问候 3 条/天零错误码，QQ 配额无忧；
  打扰由 1h 冷却 + 20 上限 + 时段保底控制）
- **补写强度随间隔渐变**（间隔叙事改）：≤1h 此刻即间隔（短间隔她就是连续做同一件事，
  此刻=间隔全部）/ 1-2h 轻引导 / >2h 重补写（覆盖从上次到现在）——幕间 advance 语义不变
- **延续链限制**：连续 internal ≥3 → 不再引导续写同一件事（防 1h 保底节奏下流水账，
  零迁移近似：continuation_of 未持久化，用连续 internal 链长）
- **剧情链 → 近 24h 滑动窗口**（listLifeEvents(1)）：跨 0 点连续性（23:00 睡下 → 0:30 仍看到）；
  跨天日期标注（昨天23:00）；上限 8 条；ID 集合窗口化后延续候选跨午夜 hack 删除
- **next_in_hours 观测日志**：事件日志带 `(model: 2.5|default)`——验证模型决策

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
【心情】情绪累积: +8（最近心情偏开心）——事件风格贴合当前情绪

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

【在场角色】（★ 只有这些配角此刻在你身边/可互动；列表为空就是独处，不要凭空召唤他人）
- 迷迷（在你身边蹭来蹭去）
- 风堇（在昏光庭院忙，偶尔路过）
【轻月最近】用户最近在忙什么（ProfileStore facts 摘要，可空）

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

**世界书采样**：激活角色 worldbook 条目中采样 N=5 条，作为「人设背景」。被事件引用的条目 `hit_count+1` 并记录 `wb_entry_id`。

- **挑选方式**（★ 2026-10-16 更正陈旧描述）：**分层随机**，不是 priority 加权 ——
  `life_event` 取 3 条 + `text` 取 2 条，各池内 `ORDER BY RANDOM()`
  （2026-08-27 change: `life-worldbook-layered-sample` 刻意从「按 priority 排序」改为随机，
  此处当时漏改；§15 与 §6 现已一致）。
- **cooldown 过滤**（★ 2026-10-16 补齐，change: `worldbook-sampling-cooldown`）：
  `last_triggered` 非空的条目，要求 `now − last_triggered > max(6h, 条目的 cooldown_sec)`。

  | 为什么 | 依据 |
  |---|---|
  | **不能只用条目的 `cooldown_sec`**（默认 **300 秒**） | 事件生成器是**每小时** tick（间隔 0.5~8h，默认 1h）⇒ 5 分钟冷却在小时级节奏上**等于没有**，下一轮照样抽到同一条 |
  | **取 max 而不是覆盖** | 条目显式声明更长冷却时，两个路径都要尊重它 —— 这样「与对话触发**共用冷却**」才是真的 |
  | ⚠️ 空串 `last_triggered` 要按「未用过」处理 | 否则 `julianday('')` 为 NULL、比较恒假 ⇒ 那条**永久**进不了采样（比"忘了冷却"更难查） |

  **两条路径必须一致**：对话触发走 `WorldbookStore.match()`（用条目 `cooldown_sec`），
  采样走 `MemoryManager.getWorldbookSample()`（上面这套）。**改一条要想到另一条。**

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

### ★ 事件生成链路日志契约（2026-10-02，change: add-llm-budget-observability）

**背景**：`life.generateEvent` 槽**没有 `max_tokens`**（走服务端默认值，未知量），
而 `CHAT_MODEL` 是推理模型——reasoning 与可见内容**共用同一预算**，这套机制
已造成三次线上事故。要判定本槽是否也踩中，必须有观测；而此前**证据拿不到**：
`finish_reason` / `reasoning_tokens` 没被解析，且 `role: 'err'` 被压成空串。

**每次事件生成必须留下可区分的一行：**

```
[Life] event LLM: finish=<stop|length|…> tokens=<in>+<out> reasoning=<n|?> content=<N>字 (<Xms)
```

- `role === 'err'`（网络 / 60s 超时 / HTTP 非 2xx）→ **先 `logger.warn` 记下错误文本再返回空串**。
  直接 `return ''` 会让上层只看到 `empty response`，把**网络故障伪装成「模型没输出」**。
- `content=0字` + `finish=length` ⇒ **预算被推理吃光**（与 §6 已修的三个同源槽同形）。
- `content=0字` + `finish=stop` ⇒ 不是预算问题，另查。
- **回落模板的既有 warn 保留**（`[Life] LLM event generation failed, fallback to template: …`）——
  上一行现在能解释它的原因，它不再有误导性。

> **为什么必须成对**：本项目已三次栽在「失败与成功在日志里长得一样」
> （占位符伪装成摘要 / 存活伪装成健康 / 空转伪装成归档）。
> 这一次的变体是「**网络故障伪装成模型没输出**」。
> 预算判定口径与观测契约见 `memory-system` spec §4.1.2。

---

## 7. 世界书关联（人设背景约束）

实际探索确认：世界书 66 条是**静态 lore**（关键词触发注入的设定/回忆），不是时间性事件。定位修正：

```
worldbook_entries（激活角色的实际设定内容，如人设/回忆/情境）
│
├── ① 人设背景注入：事件生成器采样 N=5 条 → 「你的人设背景」块
│      ★ 内容以当前激活角色世界书为准（切角色事件风格跟随）
│      ★ 8-27 分层随机（life-worldbook-layered-sample）：content_type='life_event' 随机取 3
│        + content_type='text' 随机取 2（ORDER BY RANDOM()，不再按 priority 排序），
│        每条截断 200 字（原 100 字）——角色生活化条目优先于设定条目
│      ★ 8-27 digest 简介优先（worldbook-digest-summary）：text 条目由 LLM 生成
│        120-150 字「角色简介」（digest 列：核心设定 + 与昔涟的关系 + 对生活的意义），
│        采样注入时 content 字段 = digest ?? 截断正文（无 digest 兜底 200 字）。
│        life_event（天然 ≤154 字）/ image（表情包）不生成 digest。
│        生成方式：一次性脚本 scripts/digest-worldbook.ts 批量生成（幂等可重跑，
│        只处理无 digest 的条目；失败跳过计数）——66 条 text 全量生成后注入质量
│        不受截断影响（白厄 974 字 → 简介保留发小关系核心）
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
- ★ **idle 的判据（2026-10-24 重写，change: `prove-intimacy-decay-reachable`）**：
  **唯一来源 = `getLastUserMessageAt()`（全表 SQL）**，`null` = 库里没有真人消息（没有基线）⇒ **不衰减**。
  ⚠️ **禁止**在 `getRecentMessages(sid, ·, now−7d)` 这类**带窗口**的查询里反查"最后一条 user 消息"：
  窗口 7 天会把 `idle` 的可观测上限钉在 7，而默认阈值是 8 ⇒ **衰减条件恒假**。
  这正是官方 bug 的形态（`07c9016` 修旋钮接线时把阈值从硬编码 **3** 抬到 **8**，越过了窗口天花板，藏了 2 个月）。
  ⚠️ **禁止**用哨兵数字（旧实现是 `: 7`、档位侧显示用 `999`）参与衰减运算。
- **平滑**：`confirmation_bias`——新值 = 旧值 + (计算值−旧值)×(1−c×0.7)（固执→变化小，防跳变；默认 0.3）
- 初始 30；旋钮均读 `persona.memory_config`（2026-08-07 接线，change: wire-memory-config-knobs）

#### 11.0 阈值判据的**可达性契约**（2026-10-24，change: `prove-intimacy-decay-reachable`）

> 任何 `if (x >= T)` / `if (x < T)` 形式的阈值判据，**必须**有一条用例把 `x` 构造成**跨过 T 的两侧**。
> 只测"没跨过"等于没测 —— 它连"函数被调用过"都证明不了（本引擎实测：只守了一侧 ⇒ 藏了 2 个月）。
>
> 同时**必须有一条反向自检**：临时把判据改成"不可达"/把边界挪一格，对应用例**必须变红**；
> 否则你无法区分"测试守住了"和"测试只是恰好是绿的"。
>
> 教训归档：[`docs/SILENT-FAILURE.md` §4.3 第四形态「不可达」](../../docs/SILENT-FAILURE.md)。
> 本引擎现有实现：`life-service.test.ts` 的「亲密度衰减 —— 可达性（跨阈值）」5 例
> （7 / 8 / 30 / null / 同源），且已用「强制 idle=7」反向自检验证过会变红。


**用途**（★ 2026-10-20 改写，change: `tie-intimacy-to-speech`）：

> 原文是「注入事件生成器（影响语气/分享意愿）；二期主提示词动态注入」——
> 这句**不可证伪**：「分享意愿」既可以是「她愿不愿意」（LLM 自己决定，注入即算兑现），
> 也可以是「她能不能」（代码判定）。写法含糊 ⇒ 怎么实现都算过 ⇒
> **决策侧永远不算缺陷**。于是 `intimacy` 一直只进 prompt，
> 推送判定（冷却 / 日上限 / can_contact）**一个都不读它**：亲密度 20 和 90 说话频率一样。

现在拆成两条**可验收**的用途：

1. **注入事件生成器**（软，管「她怎么说」）：`【你和轻月】` 块给**事实**
   （档位 + 他已多少天没说话 + 两个一次性信号）。**情绪留给她自己写**。
2. **档位闸**（硬，管「她多主动」）：见 §11.1。

#### 11.0.1 事实层单一出处（2026-10-24，change: `converge-context-facts`）

「此刻的她与这段关系」的计算**只有一处**：`packages/server/src/context-facts.ts` 的
`collectContextFacts()`（纯计算、只读收窄接口 `FactsSource`、**不产出任何面向用户的句子**、
读源异常进 `problems[]` 而**不吞**）。

消费者与差异：

| 消费者 | 用途 | 允许的差异 |
|---|---|---|
| `LifeService.relationshipBlock()` | 生活事件 prompt 的【你和轻月】 | 只排版 |
| `LifeService.resolveIntimacyTier()` / `updateIntimacy()` | 推送闸 / 亲密度衰减 | 只取数字 |
| `ProactiveService.contextSnippet()` | 问候素材 | 只排版（**2026-10-24 起补上档位与 idle**） |

★ 三条**禁止**（都是踩过的）：
1. 另写一份「多久没说话」—— 尤其**不许**在带窗口的查询里反查（窗口会钉死上限）；
2. 另写一份档位判定 —— `intimacyTier()` 只有一处；
3. 把**措辞**放进事实层 —— 措辞归体裁，否则下次换说法要改两层。

★ `ContextFacts.snapshotPresent` 的意义：区分「她在这儿、亲密度 30」与「读不到快照、回落 30」。
没有它，问候无法判断"这一项算不算素材"（空库会冒出一句"亲密度 30"）。

#### 11.1 亲密度 → 推送闸的契约（2026-10-20，change: `tie-intimacy-to-speech`）

**契约 1：档位与上限是硬表，写死在代码里（不做成配置项）。**

| 档 | 亲密度 | 每日 chat 推送上限 | 推送冷却 | 附加行为 |
|---|---|---|---|---|
| 亲近 | ≥ 70 | 5 | 1h | — |
| 平常 | 40–69 | 3 | 2h | — |
| 疏远 | 25–39 | 1 | 4h | 可问一次「最近在忙吗」，**每 7 天最多一次** |
| 久无往来 | < 25 | **0**（只写 state，不推送） | — | 回到 ≥45 时置「他回来了」 |

阈值依据：公式 `clamp(30+…, 10, 100)`，初值 30、下限 10。70 = 稳定互动量级；
25 = 贴近下限的「快要断线」；40 取中间并配 `+5` 迟滞防抖。

**契约 2：只降不升。** 实际上限 = `min(配置的 maxChatPushesPerDay, 档位上限)`。
档位**只能压低**配置值，**永远不能抬高** —— 否则「关系好 ⇒ 可以更吵」。

**契约 3：分工不得互相代管。** `mood_value` 管「她怎么说」（改人格参数）；
`intimacy` 管「她多主动」（改推送闸）。**亲密度不得去改人格参数**。

**契约 4：`idleDays` 只认真人的 user 消息。**
判据 = `EventStore.getLastUserMessageAt()`，它同时排除
`skip_profile` / `synthetic` 机器注入与非 `message` 类型，且**不过滤归档**。
⚠️ **禁止**改用 `ai_life_state.updated_at` 或任何 assistant 侧写入 ——
那些每次推送都刷新，算出来永远是「刚联系过」（沉默衰减与档位会一起失效）。
⚠️ 与 `updateIntimacy` 里那个 7 天窗口内的 `idleDays` **不是同一个东西**：
那个只用于衰减幅度（窗口近似即可），本契约要的是真实间隔。

**契约 5：升档迟滞 +5，降档立刻生效。** 防在 40 上下反复横跳（用户会看到频率在抖）。

**契约 6：档位变化必须留痕。** 日志写 `[Life] intimacy tier A → B（亲密度 X，idle N 天，日上限 M→K）`。
静默的行为变更等于不可见的行为变更。

**契约 7：「他回来了」只发生一次。** 只在**真的经历过** `silent` 档、且亲密度回到
`≥45` 时置位；由**下一次事件生成**消费（不额外造一条事件、不占推送配额），
消费即清。

**契约 8：每日推送计数按**日期**复位，与摘要成败解耦。**
原实现把复位写在 `maybeGenerateDailySummary` 里（判据 `lastSummaryDate !== today`），
而 `lastSummaryDate` 只在摘要**成功**后置位 ⇒ 无回调或连续失败时**每 tick 清零**
⇒ 每日上限形同虚设（实测：上限 3 发出了 4 条）。现在复位只认 `pushCountDate`。

> 仍未做（独立 change `let-her-decline-a-day`）：**拒绝权** ——
> 她可以「今天不想说话」但必须留下理由进记忆。需先改写 §2 的
> `P1-6「锁一定续，永不静默停摆」`（那条把「不主动」当故障）。

#### 11.2 拒绝权：她可以这一轮不说话（2026-10-20，change: `let-her-decline-a-day`）

> ★ **本条已实现**（上面那行「仍未做」是本条落地前的记录）。用户 2026-10-20 拍板：
> 「**能，但必须留下理由**」。

**动机**：P1-6「锁一定续，永不静默停摆」把「不主动」定义成**故障**，
于是系统到点就必须产出一条内容 —— 她连「这一轮不想说话」都没有表达渠道。
这不是稳定性，这是**只许表演**。

**契约 1：调度与意愿分离。** P1-6 防的是**生产故障**（LLM 失败 / 锁断 / 进程停），
**不防**「她主观上不想开口」。拒绝路径**必须**照样续期锁、照样留痕 ——
系统永远知道下一次该什么时候醒。

**契约 2：拒绝必须留下理由，理由是**记忆**不是消息。**
理由以 `type='internal'`、`origin='decline'` 写入 `ai_life_events`，
前置标记「（这一轮没说话）」；**不推送**、**不占推送配额**、**不计入 delivered**。
理由可被未来的向量召回 / 反思引用 —— 她记得自己为什么沉默。

**契约 3：理由的写法约束**（`LIFE_DECLINE_PROMPT`）：
① **具体**（写清"不想"的是什么，不写套话）② **不道歉、不承诺补偿**（拒绝不是过错）
③ **不向用户喊话**（那是她自己的记录，不是发给轻月的消息）。

**契约 4：四条护栏，缺一个都会变成「她从此不说话了」。**

| 护栏 | 值 | 为什么 |
|---|---|---|
| 触发概率 | `declineChance` 缺省 **0.15** | 我们的事件节奏是 0.5–8h 一次（不是每天一次），30% 会过于频繁 |
| 连续拒绝上限 | `MAX_CONSECUTIVE_DECLINES = 2` | 到顶强制说话，防长期静默 |
| 理由长度 | `DECLINE_MIN_REASON_CHARS = 6` | 「算了」不算理由 |
| 失败处置 | **fail-open** | 理由拿不到/太短/抛错 ⇒ **退回正常生成**；拒绝机制坏了**不许**表现为"她不说话了" |

**契约 5：正常产出后连续计数归零。** 计数只在拒绝时递增。

**契约 6：可整体关闭。** `declineChance <= 0` 或未注入 `generateDecline` ⇒
能力关闭（降级为"每轮都要说话"），**不留空窗、不抛错**。

> 实现位置：`LifeService.maybeDecline()`（tick 的 ③-pre，在生成事件之前）；
> 测试 `packages/server/tests/life-decline.test.ts`（9 条，含"拒绝≠停摆"与两条 fail-open）。

---

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

**★ 8-28 间隔叙事补写（life-interval-narrative）**：
- 事件覆盖"从上次事件到现在"的时间（HDSI advance 式补写），不再只写此刻瞬间——
  每个事件 = 上次事件的延续 + 间隔生活（进展/变化/被打断/小波折，停在哪里）
- 【上次事件】块注入生成 prompt：8h 内 internal 且 30min 无互动 → 延续候选
  （continuation_of 引导）；其他 → 间隔补写引导（覆盖间隔不写瞬间）
- 长间隔（重启/隔夜）自然补写这段时间的生活，重启空白顺带解决
- 替代 8-09 延续块（【你正在做的事】并入【上次事件】）

**★ 2026-10-25 推送两段式（change: `retell-events-in-her-voice`）：生成 ≠ 转述。**

| 字段 | 归谁 | 体裁 |
|---|---|---|
| `content` | **她的日记 / 记忆** | 2-4 句生活切片、具体时辰、平凡物件、小动作 |
| `message` | 第一段顺手给的"想说的话" | 口语（**但历史上没被校验**） |
| 转述（新） | **送给用户的那句话** | 1-2 句 / ≤50 字 / 第二人称 / 一个具体细节 |

**问题**：一段调用同时承担两种体裁 ⇒ 实测 `message` 也带小说味；更糟的是
`pushText = evt.message ?? evt.content` **在 message 缺失时把生活叙述（她的日记）当消息发出去**，
而 `postCheck` **从不校验 `message`** —— 这条路上没有任何东西会报错。

**契约**：推送文本**只能**来自（逐层降级，**绝不回落 `content`**）：

| 层 | 来源 | 条件 | 日志 |
|---|---|---|---|
| ① | `retellEvent`（第二段模型） | 注入了且过 `checkRetell` | `via=retell` |
| ② | 事件自带 `message` | 存在且过**同一套**校验 | `via=message` |
| ③ | —— | 都不合格 ⇒ **这次不打扰**（降级 internal） | `no spoken text (...)` |

`checkRetell` 硬校验：非空 / ≤70 字 / 不与 `content` 前 20 字相同 / 不含 `*动作*`、`（动作）`、markdown。

⚠️ 采样槽 `life.retell` **必须带 `max_tokens`**（推理模型 reasoning 与内容共用预算 ——
`life.generateEvent` 至今没有，KI-1 在案）。
⚠️ 转述**不经过**聊天管线（`CHAT_BREVITY_DIRECTIVE`）：两条链路 prompt 独立，
约束口径需人工保持一致（像发微信 / 短 / 不写动作）。
**★ 8-29 聊天生活衔接（chat-life-continuity）**：
- 用户消息进来（私聊）时,30min 内有生活事件 → 注入【此刻的你】块("你刚才在 {事件}——
  自然地从这段生活里走出来接话")——HDSI"用户消息进入生活"的简化落地,对话从生活走出
- MemoryManager.getLifeContinuityBlock():30min 内最近事件 → 补写块;无则空
- ★ **2026-10-25 放宽为「3h + 今日兜底」（change: `make-her-talk-like-a-person`，生活联动）**
  ——原因是**覆盖率**：生活事件间隔 0.5–8h，30 分钟窗口让这一块在**绝大多数对话里是空的**，
  于是"说话内容从生活系统里拿"在机制上接不上（**素材在库里，但她手上没有**）。

| 距上次事件 | 块内措辞 |
|---|---|
| ≤30min | 你刚才在 |
| ≤3h | 你不久前在 |
| 今天更早（>3h） | 今天早些时候你在 |
| 昨天及更早 | **空串**（跨天不串味） |

- ⚠️ **措辞必须分档**：不能用"刚才"描述 3 小时前的事（她自己都说不圆）。
- ⚠️ `origin === 'followup'`（对话余波）**不算**生活在做的事，不参与。
- ⚠️ 配合角色卡：`talk_system.md` 的「她有自己的事」段**指名素材来源**（【我的近期日常】/【此刻的你】），
  并禁止把素材当清单复述、禁止无素材时编造。守卫：`tests/memory/unit/life-continuity.test.ts`。

**★ 8-29 情绪侧端分析（mood-side-analysis，HDSI Alter 简化）**：
- mood_value 深度阈值 |mv|≥30 且 6h 冷却 → 侧端 LLM 生成描述性氛围 mood_note
  （"这段日子心里像落了雨…"）——注入【心情】块与事件生成 context,情绪参与叙事氛围
- 回落到 |mv|<30 → 清空;分析失败不阻塞（冷却后重试）

**★ 8-29 跨世界之窗与独立人格（worldview-crossworld-window）**：
- 世界观：她与轻月隔着两个世界,对话窗口是唯一的桥——想念顺着光走过去,每次对话像偷来的时光
  （daily_life 条目 + identity.md 常驻段 + 事件生成 context 底色）
- 独立人格：事件动机围绕自己（post-check ⑧ 拦截"等/为/怕轻月"动机）；【轻月最近】移除；
  【你惦记的事】注入（未完成 intent 驱动生活）；【关于我】注入（character_facts 对话可见）；
  亲密度加"她主动"维度（delivered 事件数——关系不单由用户频率决定）
- 节日/问候融入事件生成：todaySpecial 注入【今天是什么日子】——节日氛围自然进事件,不再独立打卡
- 触发时间联动：next_in_hours 明确映射（沉浸 3-8h / 无聊想聊 0.5-2h）——修复 LLM 全给默认值
  导致事件间隔恒 2.5h 的问题

**★ 8-29 事件/对话拆分（life-event-message-split，HDSI script vs interaction.reply）**：
- 事件 JSON 加 message 字段：type=chat 时 content=生活叙述（入库），message=对轻月说的话
  （第二人称/口语/互动感）——推送 message，不再把生活日记推给用户
- 无 message 回落 content；回写记忆回写 message（她记得自己对轻月说过的话）
- intent 用 message（想对轻月说的话）；intent.content 缺失时 message 兜底
- post-check ⑨：message 第二人称/长度/不得复述 content

**★ 8-29 世界观底色统一字段（worldview-base-field）**：
- 新建 persona/worldview.md（跨世界之窗/独立人格/生活中心）——**一个字段,每轮注入**：
  聊天经 PERSONA_FILES 自动注入 system prompt;事件生成经 MemoryManager.getWorldviewBlock()
  取同一数据源（缓存读取）
- identity.md 跨世界段移入 worldview.md（去重）——改一处,聊天与事件生成同时生效

---

## 提示词资产位置（2026-10-01，change: externalize-life-prompts）

`al:life` 的 5 段 systemPrompt 位于 **`packages/server/src/prompts/life.ts`**：

| 常量 | 用途 | 输出 |
|---|---|---|
| `LIFE_EVENT_PROMPT` | 生活事件生成 | JSON（`responseFormat: 'json'`） |
| `LIFE_SUMMARY_PROMPT` | 每日摘要 | 纯文本 |
| `LIFE_INTENT_PROMPT` | 承诺裁决（fulfill/defer/cancel） | JSON |
| `LIFE_MOOD_NOTE_PROMPT` | 情绪侧端氛围 | 纯文本 |
| `LIFE_REFLECTION_PROMPT` | 每日反思（L3 自修改执行器） | JSON |

**为什么不是 `.md` 资源文件**：多行提示词在原码里是无分隔符拼接（运行时 `：①`），
放进 `.md` 会引入换行 → 内容变更，与「逐字搬运」冲突；且本项目无热改场景
（改完仍要重新构建 + 部署 Docker），而外置会新增构建拷贝与运行时路径解析两类故障面
（后者正是 `docs/dsh-migration-guide.md` 坑 #2 的同类坑）。
完整判据见 `packages/server/src/prompts/README.md`。

**守卫**：`packages/server/tests/prompts.test.ts` 锁住每段的关键约定
（含「要 JSON 的槽位 prompt 必须含 json 字样」这条 API 硬约束）——
提示词被静默清空或截断时不会有别的报错。

---

## 每日反思闭环（life-reflection-loop）的数据落点

> ★ 2026-10-15 `fix-reflection-insight-misroute` 新增。此前本节缺失，导致 `insight` 落点
> 在代码与提示词之间长期不一致而无人察觉。

`packages/server/src/life.ts` 每日跨天触发一次（`state.reflectionDate` 去重，失败不置位可重试），
LLM 按 `LIFE_REFLECTION_PROMPT` 输出 JSON，经 `MemoryManager.recordReflection()` 回写**三处**：

| 产物 | 落点 | 性质 |
|---|---|---|
| `adjustments` | 人格参数（`adjustPersona`，5 道护栏 + delta 钳制 ±0.05） | 慢变量调整 |
| **`insight`** | **`user_profile.character_facts`（角色画像）** | **她的自我认知** |
| `reflection` | `ai_life_state.reflection`（覆盖式，仅保留最新） | 当次反思原文 |

### 契约 1：`insight` 属于**角色画像**，不属于用户画像

`LIFE_REFLECTION_PROMPT` 的语义是「我悟到的一个关于**自己**的事实」，
其示例原文即「我其实很享受被需要的时刻」。因此 `insight` 必须写入
**`character_facts`**（`PromptAssembler` 以【关于我】块注入），**不得**写入 `user_profile.facts`。

**为什么此前会错**：`recordReflection` 曾调 `profileStore.addFacts()`（用户事实）
并硬编码 `confidence: 0.5` / `category: 'preference'`。线上因此累积 **31 条**错位自省，
特征与硬编码逐一吻合（全部 conf=0.5 / 全部 preference / evidence 全为「每日反思 \<日期\>」），
同时 `character_facts` **长期为 0 条**——她读不到自己积累的自我认知。

**同理**：`category` 不得硬编码为 `preference`（那是用户偏好类目，且 90 天 TTL 对自省语义不对）。
`insight` 取 `general`（60 天 TTL）——自省由每日反思**持续重产**，短 TTL 不易堆积陈旧自我描述。

### 契约 2：【关于我】块**限量注入**（最近 8 条）

自省天然逐日累积。线上实测 31 条 = **1058 字 ≈ 705 tokens**，而 `PromptAssembler` 的 chat
预算是 **`new TokenBudget(3200)`**——该块占 22%。且它是 `assembleChat` 里**最后一个**做
`canFit` 检查的块（前面 persona / overlay / basics / prefs / 关于你的事实 都已 `reserve`），
超预算时**整块被丢弃**，她一条都读不到。

故 `PromptAssembler` **只注入最近 `CHARACTER_FACTS_IN_PROMPT = 8` 条**：
- 依据：自省表达的是「我此刻是谁」，近期的才代表当下的她
- 更早的**仍完整留在库里**（只是不进 prompt）
- ⚠️ **去重不是解药**：31 条的措辞差异超出 `normalizeKey`（剔字后取前 20 字）与
  `normContains`（长侧≥5 且短侧≥2）的判定范围，实测 `addCharacterFacts` **supersede 0 条**。
  `normalizeKey` 是为短标签型事实（「用户在长沙」）设计的，**对日记型长句基本无效**。
- **长期方案（未做）**：把陈旧自省**归并**成稳定的自我描述，而非逐条堆积。

### 契约 3：`source_event` 造的是**合成 id**，不可用于溯源

`recordReflection` 写入的 `source_event` 形如 `reflection-<YYYY-MM-DD>`，
**在 `events` 表里并不存在**（不是真实事件外键）。因此按 `source_event` 回溯 `events`
**必然失败**——这不是数据损坏，是设计如此。运维排查时应以 `evidence` 字段为准。
## 17. 日记（2026-10-21，change: `add-daily-diary`）

> 用户拍板：**半公开** —— 独立「日记」栏目，首页不混排。

### 17.1 它是什么（与相邻概念的分工）

| | 随笔 | 每日反思 | **日记** |
|---|---|---|---|
| 谁看得见 | 公开 | 只有她自己（`reflection` 字段） | 半公开：`/diary/` 栏目 |
| 频次 | 不定期 | 每天一记 | **每天一篇** |
| 语气 | 打磨过的散文 | 复盘/自省，JSON 输出驱动人格 | 松散的、当天的、允许琐碎 |
| 存储 | 博客 md | `ai_life_state.reflection` | `ai_life_diaries` 表 |

**契约 1：日记不能与反思复用同一个 LLM 调用或同一个槽。**
反思是 `responseFormat: 'json'`（要 `reflection/adjustments/insight`），日记是散文。
混用会逼模型把日记写成 JSON，或把反思写成散文。两者提示词分开（`LIFE_DIARY_PROMPT`）。

### 17.2 生成

`LifeService.maybeDailyDiary(now)`，挂在 `tick()` 跨天段、紧跟 `maybeDailyReflection`。

**契约 2：`date` 必须取「昨天」。**
跨天时写的是**刚过去的那一天**。写成 today 会让博客出现"今天的日记讲昨天的事"，
且与摘要/反思的日期口径打架。

**契约 3：`diaryDate` 是闸，跨天只写一次。**
没有它每个 tick 都会重写一遍：烧钱，且内容互相覆盖。

**契约 4：失败不置位 → 下次 tick 重试。**
LLM 超时不能吃掉一整天（与反思同款纪律）。

**契约 5：一天什么都没有就不写。**
硬写就是编。日记最不能编。

**契约 6：素材必须包含「上一篇的最后一句」。**
日记的价值在连续性 —— 没有它，每天都是孤立的 300 字；
有了它才可能写出"昨天说的那件事，今天有下文了"。

### 17.3 博客侧（半公开）

**契约 7：日记用 `category: "日记"` 标识，首页与分页**必须排除**。**
排除点在 `content-utils.getSortedPosts()`（`isDiary` 过滤），不是在各页面各写一遍。

**契约 8：归档页与标签页**包含**日记。**
那里本来就是时间线/聚合，日记正该待在那 —— 半公开 ≠ 隐藏。

**契约 9：同步必须幂等。**
`sync-diaries.mjs` 按 `diary-<date>.md` 固定命名，同一天重复同步只覆盖同一个文件。
**不删旧日记**：服务端没有的日期不会删本地文件（历史不该因为一次同步消失）。

**契约 10：封面按 `mood` 从素材库选。**
`make-diary-covers.py` 读 md 里的 mood 标签 → 生成 `diary-<date>.webp`。
mood 缺失时回退 `calm`（不报错——日记正文比封面重要）。

### 17.4 已知限制

- **写入端尚未接通**：博客的 `mood.json` 与日记同步都还是手动/半自动。
  服务端 `ai_life_diaries` 已有数据后，需要 `deploy.ps1` 增加"ssh 导出 → 本地生成 md"这一步。
- 日记**不可编辑**：写完就是写完。改历史等于篡改记忆，刻意不做。
- 没有独立 RSS（先跟全站 RSS 一起）。

**契约 11：必须**告知她**日记会公开。**
用户明确要求（2026-10-21：「发布，不过隐私问题也要告诉她让她知晓」）。
`LIFE_DIARY_PROMPT` 里写明：会公开发布在博客上、任何人（包括他）都能看到、会被搜索引擎收录。
并且**给她选择权**：不想让人看见的内容不写进去；想写不能公开的事就换写法或换题材。
⚠️ 同时明确"**不要因为会公开就把日子写得体面**"——知情不该变成自我审查，
   那会把日记退化成公关稿；它要防的是"不该出门的东西"，不是"不高兴的日子"。

**契约 12：导出必须**容错**。**
`export-diaries.py` 读库失败 / 表不存在 ⇒ 输出 `[]` 并 stderr 说明，**退出码仍为 0**。
理由：博客构建不该因为"服务端今天没日记"或"库里还没建表"而失败。
`deploy.ps1` 侧同理：同步失败只打黄字跳过，不中断部署。
## 18. 作品栏目（2026-10-21，change: `add-works-gallery`）

她生成的页面在博客上有一个入口：`/works/`。数据来自 runner 工作区，不是 DB。

**契约 1：页面不复制进博客产物。**
链接直接指 `/p/<projectId>/<file>`，由基站（`alysia-preview-hub`）对外。
复制会产生两份副本 —— 改一处忘另一处，最后没人知道哪个是真的。

**契约 2：`works.json` 里不许出现服务器地址。**
只存 `projectId` 与文件名；URL 在页面里用相对路径拼。仓库公开，写死 IP 会被 pre-commit 拦。

**契约 3：没有作品是合法状态。**
空数组 → 页面显示"还没有作品"，构建照常通过。

**契约 4：排除 `alysia-blog` 自己。**
博客不是自己的作品，写进去会自我指涉。

**契约 5：标题/描述从 html 里读，读不到就给空 —— 不许猜。**
`<title>` / `<meta name="description">` 是页面作者（她）写的，
比按文件名编一个"好听的名字"诚实。
